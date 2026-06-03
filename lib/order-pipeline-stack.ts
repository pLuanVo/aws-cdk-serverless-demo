import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';

export class OrderPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Encryption ---
    const key = new kms.Key(this, 'DataKey', {
      alias: 'order-pipeline',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Storage ---
    const ordersTable = new dynamodb.Table(this, 'OrdersTable', {
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
    });

    const receiptsBucket = new s3.Bucket(this, 'ReceiptsBucket', {
      encryptionKey: key,
      encryption: s3.BucketEncryption.KMS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // --- Messaging ---
    const notificationTopic = new sns.Topic(this, 'NotificationTopic', {
      displayName: 'Order Notifications',
      masterKey: key,
    });

    const dlq = new sqs.Queue(this, 'OrderDLQ', {
      retentionPeriod: cdk.Duration.days(14),
      encryptionMasterKey: key,
    });

    // --- Secrets ---
    const webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      secretStringValue: cdk.SecretValue.unsafePlainText('https://httpbin.org/post'),
    });

    // --- Lambda Functions ---
    const validateOrderFn = new lambda.Function(this, 'ValidateOrderFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/validate-order')),
      environment: { ORDERS_TABLE: ordersTable.tableName },
      timeout: cdk.Duration.seconds(30),
    });
    ordersTable.grantWriteData(validateOrderFn);
    key.grantEncryptDecrypt(validateOrderFn);

    const generateReceiptFn = new lambda.Function(this, 'GenerateReceiptFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/generate-receipt')),
      environment: { RECEIPTS_BUCKET: receiptsBucket.bucketName },
      timeout: cdk.Duration.seconds(30),
    });
    receiptsBucket.grantWrite(generateReceiptFn);
    key.grantEncryptDecrypt(generateReceiptFn);

    const sendNotificationFn = new lambda.DockerImageFunction(this, 'SendNotificationFn', {
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../lambda/send-notification'),
      ),
      environment: {
        NOTIFICATION_TOPIC_ARN: notificationTopic.topicArn,
        WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });
    notificationTopic.grantPublish(sendNotificationFn);
    webhookSecret.grantRead(sendNotificationFn);
    key.grantEncryptDecrypt(sendNotificationFn);

    // --- Step Functions ---
    const errorHandler = (stage: string) =>
      new tasks.SqsSendMessage(this, `SendToDLQ-${stage}`, {
        queue: dlq,
        messageBody: sfn.TaskInput.fromJsonPathAt('$'),
      }).next(new sfn.Fail(this, `Failed-${stage}`, {
        error: 'ProcessingError',
        cause: `Failed at ${stage} stage`,
      }));

    const validateTask = new tasks.LambdaInvoke(this, 'ValidateOrder', {
      lambdaFunction: validateOrderFn,
      outputPath: '$.Payload',
    }).addCatch(errorHandler('Validate'), { resultPath: '$.errorInfo' });

    const receiptTask = new tasks.LambdaInvoke(this, 'GenerateReceipt', {
      lambdaFunction: generateReceiptFn,
      outputPath: '$.Payload',
    }).addCatch(errorHandler('Receipt'), { resultPath: '$.errorInfo' });

    const notifyTask = new tasks.LambdaInvoke(this, 'SendNotification', {
      lambdaFunction: sendNotificationFn,
      outputPath: '$.Payload',
    }).addCatch(errorHandler('Notify'), { resultPath: '$.errorInfo' });

    const definition = validateTask.next(receiptTask).next(notifyTask);

    const stateMachine = new sfn.StateMachine(this, 'OrderPipeline', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(5),
      tracingEnabled: true,
    });
    key.grantEncryptDecrypt(stateMachine);

    // --- API Gateway ---
    const api = new apigateway.RestApi(this, 'OrderApi', {
      restApiName: 'Order Processing API',
      description: 'POST /orders → Step Functions pipeline',
    });

    const apiRole = new iam.Role(this, 'ApiGwRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
    stateMachine.grantStartExecution(apiRole);

    const orders = api.root.addResource('orders');
    orders.addMethod(
      'POST',
      new apigateway.AwsIntegration({
        service: 'states',
        action: 'StartExecution',
        integrationHttpMethod: 'POST',
        options: {
          credentialsRole: apiRole,
          requestTemplates: {
            'application/json': `{
              "input": "$util.escapeJavaScript($input.json('$'))",
              "stateMachineArn": "${stateMachine.stateMachineArn}"
            }`,
          },
          integrationResponses: [{
            statusCode: '200',
            responseTemplates: {
              'application/json': `{
                "executionArn": "$input.json('$.executionArn')",
                "startDate": "$input.json('$.startDate')"
              }`,
            },
          }],
        },
      }),
      { methodResponses: [{ statusCode: '200' }] },
    );

    // --- GitHub Actions OIDC ---
    const githubOrg = this.node.tryGetContext('githubOrg') || 'pLuanVo';
    const githubRepo = this.node.tryGetContext('githubRepo') || 'aws-cdk-serverless-demo';

    const oidcProvider = new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const deployRole = new iam.Role(this, 'GitHubDeployRole', {
      roleName: `github-actions-${githubRepo}`,
      assumedBy: new iam.WebIdentityPrincipal(
        oidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': `repo:${githubOrg}/${githubRepo}:*`,
          },
        },
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),
      ],
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'OrdersEndpoint', { value: `${api.url}orders` });
    new cdk.CfnOutput(this, 'StateMachineArn', { value: stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'OrdersTableName', { value: ordersTable.tableName });
    new cdk.CfnOutput(this, 'ReceiptsBucketName', { value: receiptsBucket.bucketName });
    new cdk.CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
    new cdk.CfnOutput(this, 'DlqUrl', { value: dlq.queueUrl });
  }
}
