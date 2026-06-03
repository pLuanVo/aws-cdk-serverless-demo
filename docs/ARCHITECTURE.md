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
│                  Step Functions                          │
│                                                          │
│  ┌─────────────┐   ┌────────────────┐   ┌─────────────┐ │
│  │  Validate   │──▶│   Generate     │──▶│   Send       │ │
│  │  Order      │   │   Receipt      │   │   Notify     │ │
│  │  (Lambda)   │   │   (Lambda)     │   │   (Lambda)   │ │
│  └──────┬──────┘   └───────┬────────┘   └──────┬───────┘ │
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

## Services

| Service | Purpose | Encryption |
|---|---|---|
| API Gateway | REST endpoint, VTL request mapping to Step Functions | TLS |
| Step Functions | Orchestrate 3-step pipeline with per-stage error handling | — |
| Lambda (validate-order) | Validate payload, write to DynamoDB | — |
| Lambda (generate-receipt) | Build receipt JSON, write to S3 | — |
| Lambda (send-notification) | Publish SNS + POST external webhook | Container (ECR) |
| DynamoDB | Orders table (on-demand, single-table) | KMS CMK |
| S3 | Receipt JSON archive | KMS CMK |
| SNS | Fan-out notifications | KMS CMK |
| SQS | Dead-letter queue for failed executions | KMS CMK |
| KMS | Customer Managed Key, auto-rotation enabled | — |
| Secrets Manager | Webhook URL for external notification | — |
| ECR | Container image for send-notification Lambda | — |

## Design Decisions

### Why container Lambda for send-notification?

The notification Lambda uses the `requests` library to POST to an external webhook. `requests` is not included in the default Lambda Python runtime — a container image cleanly bundles the dependency without Lambda Layers. This also demonstrates the ECR → Lambda container workflow.

### Why KMS CMK instead of AWS-managed keys?

Customer Managed Keys demonstrate key rotation policy, cross-service key sharing, and fine-grained IAM grants — all relevant in regulated environments (fintech, healthcare). The single shared key simplifies the demo; production would use per-service keys.

### Why API Gateway → Step Functions (direct)?

Direct integration via VTL request templates avoids an unnecessary "router" Lambda. API Gateway handles request validation and Step Functions manages orchestration — each service does what it's built for.

### Why separate error states per stage?

Each Lambda task catches to its own `SqsSendMessage → Fail` chain. This preserves the failing stage name in the Step Functions execution history, making debugging straightforward in the console.

## CI/CD

GitHub Actions with OIDC federation (zero stored secrets):
- **00-lint.yml** — TypeScript type checking on push and PR
- **01-deploy.yml** — `cdk synth` + `cdk deploy` on push to main, authenticated via OIDC role

Bootstrap flow (chicken-egg): deploy locally once to create the OIDC role, then all subsequent changes go through CI.
