import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Encryption } from './constructs/encryption';
import { DataStores } from './constructs/data-stores';
import { Messaging } from './constructs/messaging';
import { Processing } from './constructs/processing';
import { Api } from './constructs/api';

export class OrderPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const encryption = new Encryption(this, 'Encryption');

    const dataStores = new DataStores(this, 'DataStores', {
      key: encryption.key,
    });

    const messaging = new Messaging(this, 'Messaging', {
      key: encryption.key,
    });

    const processing = new Processing(this, 'Processing', {
      ordersTable: dataStores.ordersTable,
      receiptsBucket: dataStores.receiptsBucket,
      notificationTopic: messaging.notificationTopic,
      dlq: messaging.dlq,
      webhookSecret: encryption.webhookSecret,
      key: encryption.key,
    });

    const api = new Api(this, 'Api', {
      stateMachine: processing.stateMachine,
    });

    // --- GitHub Actions OIDC (kept at stack level to preserve logical IDs) ---
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

    // --- Bitbucket Pipelines OIDC ---
    const bbWorkspace = this.node.tryGetContext('bitbucketWorkspace') || 'vpluan';
    const bbWorkspaceUuid = this.node.tryGetContext('bitbucketWorkspaceUuid') || '66498734-701c-49a9-b464-4caf78daa1f5';
    const bbRepoUuid = this.node.tryGetContext('bitbucketRepoUuid') || '{57c466d7-eb76-4c3e-abab-e2c940924e38}';

    const bbOidcProvider = new iam.OpenIdConnectProvider(this, 'BitbucketOidc', {
      url: `https://api.bitbucket.org/2.0/workspaces/${bbWorkspace}/pipelines-config/identity/oidc`,
      clientIds: [`ari:cloud:bitbucket::workspace/${bbWorkspaceUuid}`],
    });

    const bbDeployRole = new iam.Role(this, 'BitbucketDeployRole', {
      roleName: `bitbucket-deploy-${githubRepo}`,
      assumedBy: new iam.WebIdentityPrincipal(
        bbOidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            [`api.bitbucket.org/2.0/workspaces/${bbWorkspace}/pipelines-config/identity/oidc:aud`]:
              `ari:cloud:bitbucket::workspace/${bbWorkspaceUuid}`,
          },
          StringLike: {
            [`api.bitbucket.org/2.0/workspaces/${bbWorkspace}/pipelines-config/identity/oidc:sub`]:
              `${bbRepoUuid}:*`,
          },
        },
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),
      ],
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.restApi.url });
    new cdk.CfnOutput(this, 'OrdersEndpoint', { value: `${api.restApi.url}orders` });
    new cdk.CfnOutput(this, 'StateMachineArn', { value: processing.stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'OrdersTableName', { value: dataStores.ordersTable.tableName });
    new cdk.CfnOutput(this, 'ReceiptsBucketName', { value: dataStores.receiptsBucket.bucketName });
    new cdk.CfnOutput(this, 'GitHubDeployRoleArn', { value: deployRole.roleArn });
    new cdk.CfnOutput(this, 'BitbucketDeployRoleArn', { value: bbDeployRole.roleArn });
    new cdk.CfnOutput(this, 'DlqUrl', { value: messaging.dlq.queueUrl });
  }
}
