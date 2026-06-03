import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';

export interface ProcessingProps {
  readonly ordersTable: dynamodb.Table;
  readonly receiptsBucket: s3.Bucket;
  readonly notificationTopic: sns.Topic;
  readonly dlq: sqs.Queue;
  readonly webhookSecret: secretsmanager.Secret;
  readonly key: kms.Key;
}

export class Processing extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: ProcessingProps) {
    super(scope, id);

    const validateOrderFn = this.createValidateOrderFn(props);
    const generateReceiptFn = this.createGenerateReceiptFn(props);
    const sendNotificationFn = this.createSendNotificationFn(props);

    this.stateMachine = this.createStateMachine(
      validateOrderFn, generateReceiptFn, sendNotificationFn, props,
    );
  }

  private createValidateOrderFn(props: ProcessingProps): lambda.Function {
    const fn = new lambda.Function(this, 'ValidateOrderFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/validate-order')),
      environment: { ORDERS_TABLE: props.ordersTable.tableName },
      timeout: cdk.Duration.seconds(30),
    });
    props.ordersTable.grantWriteData(fn);
    props.key.grantEncryptDecrypt(fn);
    return fn;
  }

  private createGenerateReceiptFn(props: ProcessingProps): lambda.Function {
    const fn = new lambda.Function(this, 'GenerateReceiptFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/generate-receipt')),
      environment: { RECEIPTS_BUCKET: props.receiptsBucket.bucketName },
      timeout: cdk.Duration.seconds(30),
    });
    props.receiptsBucket.grantWrite(fn);
    props.key.grantEncryptDecrypt(fn);
    return fn;
  }

  private createSendNotificationFn(props: ProcessingProps): lambda.DockerImageFunction {
    const fn = new lambda.DockerImageFunction(this, 'SendNotificationFn', {
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../../lambda/send-notification'),
      ),
      environment: {
        NOTIFICATION_TOPIC_ARN: props.notificationTopic.topicArn,
        WEBHOOK_SECRET_ARN: props.webhookSecret.secretArn,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });
    props.notificationTopic.grantPublish(fn);
    props.webhookSecret.grantRead(fn);
    props.key.grantEncryptDecrypt(fn);
    return fn;
  }

  private createStateMachine(
    validateFn: lambda.Function,
    receiptFn: lambda.Function,
    notifyFn: lambda.DockerImageFunction,
    props: ProcessingProps,
  ): sfn.StateMachine {
    const errorHandler = (stage: string) =>
      new tasks.SqsSendMessage(this, `SendToDLQ-${stage}`, {
        queue: props.dlq,
        messageBody: sfn.TaskInput.fromJsonPathAt('$'),
      }).next(new sfn.Fail(this, `Failed-${stage}`, {
        error: 'ProcessingError',
        cause: `Failed at ${stage} stage`,
      }));

    const validateTask = new tasks.LambdaInvoke(this, 'ValidateOrder', {
      lambdaFunction: validateFn,
      outputPath: '$.Payload',
    }).addCatch(errorHandler('Validate'), { resultPath: '$.errorInfo' });

    const receiptTask = new tasks.LambdaInvoke(this, 'GenerateReceipt', {
      lambdaFunction: receiptFn,
      outputPath: '$.Payload',
    }).addCatch(errorHandler('Receipt'), { resultPath: '$.errorInfo' });

    const notifyTask = new tasks.LambdaInvoke(this, 'SendNotification', {
      lambdaFunction: notifyFn,
      outputPath: '$.Payload',
    }).addCatch(errorHandler('Notify'), { resultPath: '$.errorInfo' });

    const definition = validateTask.next(receiptTask).next(notifyTask);

    const sm = new sfn.StateMachine(this, 'OrderPipeline', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(5),
      tracingEnabled: true,
    });
    props.key.grantEncryptDecrypt(sm);
    return sm;
  }
}
