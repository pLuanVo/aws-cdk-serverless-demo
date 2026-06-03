#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OrderPipelineStack } from '../lib/order-pipeline-stack';

const app = new cdk.App();

new OrderPipelineStack(app, 'OrderPipelineStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Serverless order processing pipeline — API GW, Step Functions, Lambda, DynamoDB, S3, SNS, SQS, KMS, ECR',
});
