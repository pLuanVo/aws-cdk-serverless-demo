import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class Encryption extends Construct {
  public readonly key: kms.Key;
  public readonly webhookSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.key = new kms.Key(this, 'DataKey', {
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      secretStringValue: cdk.SecretValue.unsafePlainText('https://httpbin.org/post'),
    });
  }
}
