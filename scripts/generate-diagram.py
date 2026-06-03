"""Generate architecture diagram using the `diagrams` library."""
from diagrams import Diagram, Cluster, Edge
from diagrams.aws.compute import Lambda, ECR
from diagrams.aws.database import Dynamodb
from diagrams.aws.integration import SimpleQueueServiceSqs as SQS
from diagrams.aws.integration import SimpleNotificationServiceSns as SNS
from diagrams.aws.network import APIGateway
from diagrams.aws.storage import S3
from diagrams.aws.security import KeyManagementService as KMS
from diagrams.aws.security import SecretsManager
from diagrams.aws.general import Client
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'assets', 'architecture')

with Diagram(
    'Order Processing Pipeline',
    filename=OUT,
    show=False,
    direction='LR',
    outformat='png',
    graph_attr={
        'fontsize': '14',
        'bgcolor': 'white',
        'pad': '0.5',
        'nodesep': '0.6',
        'ranksep': '1.5',
    },
):
    client = Client('Client')
    apigw = APIGateway('API Gateway\nPOST /orders')

    with Cluster('Step Functions State Machine'):
        validate = Lambda('Validate Order')
        receipt = Lambda('Generate Receipt')
        notify = Lambda('Send Notification\n(ECR Container)')

    dynamodb = Dynamodb('DynamoDB\nOrders')
    s3 = S3('S3 Bucket\nReceipts')
    sns = SNS('SNS Topic')
    dlq = SQS('SQS DLQ')
    kms_key = KMS('KMS CMK')
    secrets = SecretsManager('Secrets Mgr')
    ecr = ECR('ECR')

    client >> apigw >> validate >> receipt >> notify

    validate >> Edge(color='#3B48CC') >> dynamodb
    receipt >> Edge(color='#3F8624') >> s3
    notify >> Edge(color='#A166FF') >> sns

    validate >> Edge(style='dashed', color='#DD344C', label='error') >> dlq
    receipt >> Edge(style='dashed', color='#DD344C') >> dlq
    notify >> Edge(style='dashed', color='#DD344C') >> dlq

    secrets >> Edge(style='dotted', color='#666') >> notify
    ecr >> Edge(style='dotted', color='#666') >> notify
    kms_key >> Edge(style='dotted', color='#999') >> [dynamodb, s3, sns, dlq]
