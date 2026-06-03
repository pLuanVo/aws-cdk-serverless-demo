# AWS CDK Serverless Demo

End-to-end serverless order processing pipeline: **POST → API Gateway → Step Functions → Lambda (validate → receipt → notify)** with DynamoDB, S3, SNS, SQS, KMS encryption, ECR container Lambda, and GitHub Actions OIDC CI/CD. Fully CDK-provisioned, zero static secrets.

## Features

- **API Gateway** REST API with VTL request mapping to Step Functions (no router Lambda)
- **Step Functions** state machine orchestrating 3 Lambda stages with per-stage error handling
- **Lambda** ×3: two Python runtime (validate-order, generate-receipt) + one **Docker container** (send-notification via ECR)
- **DynamoDB** on-demand orders table (KMS CMK encrypted)
- **S3** receipts bucket (KMS CMK encrypted, auto-delete on stack destroy)
- **SNS** notification topic (KMS CMK encrypted)
- **SQS** dead-letter queue for failed executions (KMS CMK encrypted)
- **KMS** Customer Managed Key with auto-rotation, shared across all data stores
- **Secrets Manager** storing external webhook URL
- **ECR** container image repository for notification Lambda
- **GitHub Actions** with **OIDC federation** (workload identity, zero stored secrets)

## Architecture

```
Client POST /orders
        │
        ▼
   API Gateway (REST)
        │
        ▼
   Step Functions ─────────────────────────────────────┐
        │                                              │
   ┌────▼─────┐    ┌──────▼───────┐    ┌─────▼──────┐ │
   │ Validate  │───▶│  Generate    │───▶│   Notify   │ │
   │  Order    │    │  Receipt     │    │ (container) │ │
   │ (Lambda)  │    │  (Lambda)    │    │  (Lambda)  │ │
   └────┬──────┘    └──────┬───────┘    └─────┬──────┘ │
        │                  │                  │        │ on error
        ▼                  ▼                  ▼        ▼
   DynamoDB            S3 Bucket           SNS Topic  SQS DLQ
   (orders)        (receipts, KMS)     (notifications)
```

Design decisions and ADRs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quickstart

```bash
# 1. Clone + install
git clone <repo-url>
cd aws-cdk-serverless-demo
npm ci

# 2. Bootstrap CDK (once per account/region)
npx cdk bootstrap

# 3. Deploy (~3-5 min, builds Docker image + provisions all resources)
npx cdk deploy --require-approval never

# 4. Smoke test (happy path)
URL=$(aws cloudformation describe-stacks \
  --stack-name OrderPipelineStack \
  --query "Stacks[0].Outputs[?OutputKey=='OrdersEndpoint'].OutputValue" \
  --output text)

curl -sS -X POST "$URL" \
  -H "Content-Type: application/json" \
  --data-binary @scripts/test-payloads/happy-path.json | jq .
# expect: {"executionArn": "arn:aws:states:...", "startDate": "..."}
```

Both test scenarios with payloads: [`scripts/test-payloads/`](scripts/test-payloads/).

## CI/CD (GitHub Actions + OIDC)

Bootstrap flow (chicken-egg): deploy locally once to create the OIDC role, then all subsequent changes go through CI.

```bash
# After first deploy, get the role ARN
aws cloudformation describe-stacks \
  --stack-name OrderPipelineStack \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" \
  --output text

# Set it as a GitHub repository secret
gh secret set AWS_DEPLOY_ROLE_ARN --body "arn:aws:iam::123456789012:role/github-actions-aws-cdk-serverless-demo"
```

Push to `main` triggers: lint (TypeScript) → synth → deploy.

## Repo structure

```
.
├── README.md
├── cdk.json                           # CDK app config + GitHub OIDC context
├── package.json
├── tsconfig.json
├── bin/
│   └── app.ts                         # CDK app entry point
├── lib/
│   └── order-pipeline-stack.ts        # Single stack — all resources
├── lambda/
│   ├── validate-order/index.py        # Validate + DynamoDB put
│   ├── generate-receipt/index.py      # Receipt JSON → S3
│   └── send-notification/             # Docker container Lambda
│       ├── Dockerfile
│       ├── requirements.txt           # requests library
│       └── index.py                   # SNS publish + webhook POST
├── .github/workflows/
│   ├── 00-lint.yml                    # TypeScript type check
│   └── 01-deploy.yml                  # CDK synth + deploy (OIDC)
├── docs/
│   └── ARCHITECTURE.md                # Design decisions
└── scripts/
    └── test-payloads/                 # Curl payloads for testing
        ├── happy-path.json
        └── invalid-order.json
```

## Estimated cost

| Resource | SKU | ~Monthly idle |
|---|---|---|
| Lambda ×3 | On-demand | ~$0 (free tier: 1M requests) |
| API Gateway | REST | ~$0 (free tier: 1M calls) |
| Step Functions | Standard | ~$0 (free tier: 4K transitions) |
| DynamoDB | On-demand | ~$0 (free tier: 25 WCU/RCU) |
| S3 | Standard | < $1 |
| SNS / SQS | Standard | ~$0 |
| KMS | CMK | ~$1/mo (key) + $0.03/10K requests |
| Secrets Manager | 1 secret | ~$0.40/mo |
| ECR | 1 image | < $1 |

**Total idle: ~$2-3/month.** Destroy when not needed:
```bash
npx cdk destroy --all --force
```

## Scaling beyond this demo

This is a **single-stack demo** — the CDK layout is kept flat for readability. For a production multi-environment setup:

- **CDK Pipelines**: self-mutating CI/CD pipeline with `Wave` for parallel environment deploys, manual approval gates for prod
- **Separate stacks per concern**: `NetworkStack`, `DataStack`, `ComputeStack`, `ObservabilityStack` — deploy independently, share via `CfnOutput` / SSM Parameter Store
- **Multi-account**: AWS Organizations with separate accounts for dev/staging/prod, cross-account deployment roles
- **Monitoring**: CloudWatch Alarms on Lambda errors + Step Functions failures, X-Ray distributed tracing, CloudWatch Dashboards
- **Multi-region**: Route 53 failover, DynamoDB Global Tables, S3 Cross-Region Replication
- **Security hardening**: per-service KMS keys, VPC-bound Lambda, WAF on API Gateway, SCPs at org level
