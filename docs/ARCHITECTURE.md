# Architecture

## Overview

Serverless order processing pipeline built with AWS CDK (TypeScript). An API Gateway REST endpoint receives order payloads and triggers a Step Functions state machine that orchestrates three Lambda functions in sequence — validate, generate receipt, notify — with dead-letter queue error handling at each stage.

## Request Flow

```
Client POST /orders
        │
        ▼
┌──────────────────┐
│   API Gateway    │  REST API, request mapping to StartExecution
│   (REST)         │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────┐
│                   Step Functions                         │
│                                                          │
│  ┌─────────────┐   ┌────────────────┐   ┌─────────────┐  │
│  │  Validate   │──▶│   Generate     │──▶│   Send      │  │
│  │  Order      │   │   Receipt      │   │   Notify    │  │
│  │  (Lambda)   │   │   (Lambda)     │   │  (Lambda)   │  │
│  └──────┬──────┘   └───────┬────────┘   └──────┬──────┘  │
│     on error           on error            on error      │
│         │                  │                   │         │
│         ▼                  ▼                   ▼         │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              SQS Dead Letter Queue                  │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
         │                   │                   │
         ▼                   ▼                   ▼
    DynamoDB             S3 Bucket           SNS Topic
    (orders)         (receipts, KMS)      (notifications)
```

## Service Deep Dive

### API Gateway (REST)

Direct integration with Step Functions via VTL request mapping template — no intermediate "router" Lambda. The template escapes the JSON body and forwards it as the `input` field to `StartExecution`. This means API Gateway handles HTTP concerns (CORS, throttling, method routing) while Step Functions handles orchestration.

**In this demo:** single POST /orders endpoint, returns `{executionArn, startDate}` synchronously. The actual processing is async (Step Functions runs in the background).

### Step Functions (Standard Workflow)

Orchestrates the 3-stage pipeline with per-stage error handling. Each Lambda task uses `addCatch` to route failures to a dedicated `SqsSendMessage → Fail` state, preserving the failing stage name in the execution history.

**Why Standard, not Express:** Standard workflows are visible in the AWS Console with full execution history and visual graph — essential for a demo where you want to screenshot the execution flow. Express workflows are cheaper for high-volume but have no console visualization.

**X-Ray tracing** is enabled for end-to-end latency visibility across all Lambda invocations.

### Lambda — Zip vs Container Image

This demo deliberately uses **both** Lambda packaging patterns to demonstrate understanding of each:

| | Zip (validate-order, generate-receipt) | Container Image (send-notification) |
|---|---|---|
| **Package** | Python source bundled as .zip by CDK | Docker image built + pushed to ECR by CDK |
| **Max size** | 50 MB (zip) / 250 MB (unzipped) | 10 GB |
| **Cold start** | ~100-300ms | ~500-800ms (larger image) |
| **Dependencies** | Only `boto3` (built into Lambda runtime) | `requests` library (not in runtime) |
| **When to use** | Simple functions, AWS SDK only | External libraries, custom runtimes, large ML models |
| **Build in CI** | No Docker needed | Requires Docker daemon |

**Key point:** `send-notification` uses `requests` to POST to an external webhook — this library is not in the default Lambda Python runtime. A container image cleanly bundles the dependency. The alternative (Lambda Layer) works but adds deployment complexity.

### DynamoDB

On-demand billing (`PAY_PER_REQUEST`) — no capacity planning, pay per read/write. Single-table design with `orderId` as partition key.

**In this demo:** `validate-order` Lambda writes the validated order with status `VALIDATED`. The table is encrypted with the shared KMS CMK.

**Limitation:** on-demand can be expensive at sustained high throughput — provisioned mode with auto-scaling is cheaper for predictable workloads.

### S3

Receipt JSON archive. Each successful order generates a `receipts/{orderId}.json` file in the bucket.

**Encryption:** KMS CMK (same key as DynamoDB, SNS, SQS). **BlockPublicAccess** enabled. `autoDeleteObjects: true` adds a CDK custom resource that empties the bucket before stack deletion — required because CloudFormation cannot delete non-empty S3 buckets.

### SNS (Simple Notification Service)

**Current state:** the topic exists and `send-notification` Lambda publishes messages to it, but **no subscribers are attached**. Messages are published successfully (you can verify via CloudWatch metric `NumberOfMessagesPublished` on the topic) but are not delivered anywhere.

**To verify SNS is working:**
1. Check CloudWatch → SNS → `NumberOfMessagesPublished` metric (increments per order)
2. Or add an email subscription: `aws sns subscribe --topic-arn <ARN> --protocol email --notification-endpoint your@email.com`

**In production:** attach SQS subscription for async processing, email/SMS for alerts, Lambda for custom routing, or HTTP endpoint for webhooks.

### SQS (Dead Letter Queue)

Used **exclusively** as a dead letter queue in the Step Functions error handling path. When any Lambda stage throws an exception, the state machine catches the error, sends the full state (original input + error details) to SQS, then transitions to a `Fail` state.

**There is no retry or redrive policy configured.** Messages sit in the DLQ for 14 days (retention period) and are available for:
- Manual inspection: `aws sqs receive-message --queue-url <URL>`
- Debugging: each message contains the original order payload + the error type and cause
- Manual replay: read the message, fix the issue, re-submit the order

**In production:** add a CloudWatch Alarm on `ApproximateNumberOfMessagesVisible > 0`, attach a Lambda consumer for automatic retry/escalation, or configure a redrive policy to move messages back to a processing queue.

### KMS (Customer Managed Key)

Single CMK with **auto-rotation enabled** (annual). Encrypts all data stores: DynamoDB, S3, SNS, SQS. Each service + Lambda function is granted `kms:Encrypt` / `kms:Decrypt` via CDK's `grantEncryptDecrypt()`.

**Why CMK instead of AWS-managed keys:** demonstrates key rotation policy, cross-service key sharing, and fine-grained IAM grants — relevant in regulated environments (fintech, healthcare). AWS-managed keys (`aws/dynamodb`, `aws/s3`) are simpler but can't be shared, rotated on custom schedule, or audited at the key level.

**Trade-off:** shared key simplifies the demo. Production would use per-service keys to limit blast radius if a key is compromised.

### Secrets Manager

Stores the external webhook URL that `send-notification` Lambda reads at runtime via `secretsmanager:GetSecretValue`.

**In this demo:** the value is `https://httpbin.org/post` (a public echo service). The Lambda reads it on every invocation (could be cached for performance).

**Benefits over environment variables:** values can be rotated without redeploying Lambda, access is audited via CloudTrail, and secrets are encrypted at rest. In production, you'd enable automatic rotation via a rotation Lambda.

### ECR (Elastic Container Registry)

CDK's `DockerImageFunction` with `DockerImageCode.fromImageAsset()` automatically:
1. Builds the Docker image from `lambda/send-notification/Dockerfile`
2. Creates an ECR repository (via CDK bootstrap assets)
3. Pushes the tagged image to ECR
4. Configures the Lambda function to use the ECR image URI

This happens transparently during `cdk deploy` — both locally and in CI. No separate `docker build` / `docker push` steps needed in the workflow.

## Happy Path Flow

```
1. Client sends POST /orders with JSON body
   → {"customerName": "Nguyen Van A", "items": [...], "totalAmount": 69.97}

2. API Gateway receives request
   → VTL template escapes JSON, calls states:StartExecution
   → Returns 200: {executionArn, startDate}

3. Step Functions starts execution
   → Input: the order JSON

4. ValidateOrder Lambda (zip, Python 3.12)
   → Validates: customerName present, items non-empty, totalAmount > 0
   → Generates UUID orderId
   → Writes to DynamoDB: {orderId, customerName, items, totalAmount, status: VALIDATED}
   → Returns: validated order with orderId

5. GenerateReceipt Lambda (zip, Python 3.12)
   → Builds receipt: {receiptId: "RCP-XXXXXXXX", orderId, issuedAt, ...}
   → Writes JSON to S3: receipts/{orderId}.json (KMS encrypted)
   → Returns: receipt data + s3Key

6. SendNotification Lambda (container/ECR, Python 3.12 + requests)
   → Publishes order summary to SNS topic
   → Reads webhook URL from Secrets Manager
   → POSTs to external webhook via requests library
   → Returns: {notified: true}

7. Step Functions execution: SUCCEEDED
```

**Outputs to verify:** DynamoDB item, S3 object, SNS CloudWatch metric, Step Functions execution graph (green).

## Unhappy Path Flow

```
1. Client sends POST /orders with invalid body
   → {"customerName": "Bad Order", "items": [], "totalAmount": -10}

2. API Gateway → Step Functions (same as happy path)

3. ValidateOrder Lambda raises ValueError
   → "Items must be a non-empty list"

4. Step Functions catches the error (addCatch)
   → Adds errorInfo to state: {Error: "ValueError", Cause: "..."}
   → Routes to SendToDLQ-Validate task

5. SQS receives message
   → Message body: full state including original input + errorInfo
   → Available for 14 days in the DLQ

6. Step Functions transitions to Failed-Validate (Fail state)
   → Execution status: FAILED
   → Error: "ProcessingError", Cause: "Failed at Validate stage"
```

**Outputs to verify:** SQS message count > 0, Step Functions execution graph (red at Validate stage), no DynamoDB item created.

## CI/CD — GitHub Actions with OIDC

### How OIDC Works

```
GitHub Actions Runner                          AWS
─────────────────────                          ───
1. Workflow requests OIDC token     ──────▶   
   from GitHub's token endpoint               
                                              
2. GitHub issues JWT with claims:             
   - iss: token.actions.githubusercontent.com 
   - sub: repo:pLuanVo/aws-cdk-serverless-demo:ref:refs/heads/main
   - aud: sts.amazonaws.com                   
                                              
3. aws-actions/configure-aws-credentials      
   calls sts:AssumeRoleWithWebIdentity  ──────▶ IAM validates JWT against
   with the GitHub JWT                           OIDC provider thumbprint
                                              
4.                                    ◀────── IAM returns temporary credentials
                                               (valid 1 hour)
                                              
5. cdk deploy runs with temporary credentials
```

### Why OIDC instead of stored AWS keys?

| | OIDC (this demo) | Stored Access Keys |
|---|---|---|
| **Credentials** | Short-lived (1 hour), auto-expire | Long-lived, manual rotation |
| **Storage** | No secrets stored anywhere | AWS_ACCESS_KEY_ID + SECRET in GitHub Secrets |
| **Blast radius** | Scoped to repo + branch via trust policy | Anyone with the key has access |
| **Rotation** | Not needed — tokens are ephemeral | Must rotate periodically (risk of stale keys) |
| **Audit** | CloudTrail logs show `repo:org/repo:ref:*` as session name | CloudTrail shows IAM user, not which workflow |
| **Setup** | One-time: OIDC provider + IAM role in stack | Per-repo: generate key pair, store in GitHub |

### Bootstrap (chicken-egg)

The OIDC provider + IAM deploy role are created by `cdk deploy` (locally, first time). After that, GitHub Actions can assume the role to deploy subsequent changes. The role trusts only `repo:pLuanVo/aws-cdk-serverless-demo:*` — no other repo can assume it.

## CDK Constructs Pattern

The stack is decomposed into 5 constructs, each with typed props and public exports:

```
OrderPipelineStack (composes all + OIDC + outputs)
├── Encryption      → KMS Key, Secrets Manager
├── DataStores      → DynamoDB, S3 (depends on Encryption.key)
├── Messaging       → SNS, SQS (depends on Encryption.key)
├── Processing      → Lambda ×3, Step Functions (depends on all above)
└── Api             → API Gateway (depends on Processing.stateMachine)
```

Each construct encapsulates related resources and exposes only what other constructs need. The main stack is ~40 lines of composition — no resource definitions, just wiring.

## Design Decisions

### Why container Lambda for send-notification?

The `requests` library is not in the default Lambda Python runtime. Container image cleanly bundles the dependency. This also demonstrates the ECR → Lambda container workflow alongside the standard zip deployment.

### Why KMS CMK instead of AWS-managed keys?

Customer Managed Keys demonstrate key rotation policy, cross-service key sharing, and fine-grained IAM grants. Production would use per-service keys.

### Why API Gateway → Step Functions (direct)?

Direct integration via VTL request templates avoids an unnecessary "router" Lambda. API Gateway handles HTTP, Step Functions handles orchestration.

### Why separate error states per stage?

Each Lambda task catches to its own `SqsSendMessage → Fail` chain. This preserves the failing stage name in the Step Functions execution history, making debugging straightforward in the console.

### Why Standard workflow, not Express?

Standard workflows provide full execution history and visual graph in the AWS Console — critical for demonstrating and screenshotting the pipeline. Express is cheaper but has no console visualization.
