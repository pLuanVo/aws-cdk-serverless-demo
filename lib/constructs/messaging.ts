import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';

export interface MessagingProps {
  readonly key: kms.Key;
}

export class Messaging extends Construct {
  public readonly notificationTopic: sns.Topic;
  public readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: MessagingProps) {
    super(scope, id);

    this.notificationTopic = new sns.Topic(this, 'NotificationTopic', {
      displayName: 'Order Notifications',
      masterKey: props.key,
    });

    this.dlq = new sqs.Queue(this, 'OrderDLQ', {
      retentionPeriod: cdk.Duration.days(14),
      encryptionMasterKey: props.key,
    });
  }
}
