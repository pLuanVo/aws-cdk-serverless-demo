import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';

export interface DataStoresProps {
  readonly key: kms.Key;
}

export class DataStores extends Construct {
  public readonly ordersTable: dynamodb.Table;
  public readonly receiptsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStoresProps) {
    super(scope, id);

    this.ordersTable = new dynamodb.Table(this, 'OrdersTable', {
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.key,
    });

    this.receiptsBucket = new s3.Bucket(this, 'ReceiptsBucket', {
      encryptionKey: props.key,
      encryption: s3.BucketEncryption.KMS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });
  }
}
