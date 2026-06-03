import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';

export interface ApiProps {
  readonly stateMachine: sfn.StateMachine;
}

export class Api extends Construct {
  public readonly restApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    this.restApi = new apigateway.RestApi(this, 'OrderApi', {
      restApiName: 'Order Processing API',
      description: 'POST /orders → Step Functions pipeline',
    });

    const apiRole = new iam.Role(this, 'ApiGwRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
    props.stateMachine.grantStartExecution(apiRole);

    const orders = this.restApi.root.addResource('orders');
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
              "stateMachineArn": "${props.stateMachine.stateMachineArn}"
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
  }
}
