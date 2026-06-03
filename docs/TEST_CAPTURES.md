# Test Captures

End-to-end test results for the order processing pipeline. Screenshots taken from the AWS Console after deploying and running test payloads.

## Infrastructure

### CloudFormation Stack Resources

![CloudFormation stack resources](assets/CFN_stack_resources.png)

### Step Functions State Machine Definition

![Step Functions definition](assets/stepfunction_definition.png)

## Happy Path — Valid Order

**Payload:** [`scripts/test-payloads/happy-path.json`](../scripts/test-payloads/happy-path.json)

### Step Functions Execution (SUCCEEDED)

<!-- Step Functions console → Executions → select succeeded execution → Graph view -->

![Step Functions happy path](assets/test-step-functions-happy.png)

### DynamoDB — Order Record

<!-- DynamoDB console → Tables → select table → Explore items -->

![DynamoDB order](assets/test-dynamodb-order.png)

### S3 — Receipt JSON

<!-- S3 console → select bucket → receipts/ folder → click .json file -->

![S3 receipt](assets/test-s3-receipt.png)

### SNS — Published Messages (CloudWatch Metric)

<!-- CloudWatch console → Metrics → SNS → NumberOfMessagesPublished -->

![SNS metric](assets/test-sns-metric.png)

## Unhappy Path — Invalid Order

**Payload:** [`scripts/test-payloads/invalid-order.json`](../scripts/test-payloads/invalid-order.json)

### Step Functions Execution (FAILED)

<!-- Step Functions console → Executions → select failed execution → Graph view -->

![Step Functions error path](assets/test-step-functions-error.png)

### SQS DLQ — Failed Message

<!-- SQS console → select DLQ → Send and receive messages → Poll for messages -->

![SQS DLQ message](assets/test-sqs-dlq.png)

## CI/CD — GitHub Actions

### OIDC Deploy Workflow (GREEN)

<!-- GitHub → Actions tab → select latest Deploy run -->

![GitHub Actions deploy](assets/test-github-actions.png)

### IAM OIDC Provider

<!-- IAM console → Identity providers → token.actions.githubusercontent.com -->

![IAM OIDC](assets/test-iam-oidc.png)
