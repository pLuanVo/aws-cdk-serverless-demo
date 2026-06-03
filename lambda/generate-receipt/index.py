import json
import os
import boto3
from datetime import datetime, timezone

s3 = boto3.client('s3')
BUCKET = os.environ['RECEIPTS_BUCKET']


def handler(event, context):
    receipt = {
        'receiptId': f"RCP-{event['orderId'][:8].upper()}",
        'orderId': event['orderId'],
        'customerName': event['customerName'],
        'items': event['items'],
        'totalAmount': event['totalAmount'],
        'issuedAt': datetime.now(timezone.utc).isoformat(),
        'status': 'ISSUED',
    }

    key = f"receipts/{event['orderId']}.json"
    s3.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=json.dumps(receipt, indent=2),
        ContentType='application/json',
    )

    return {**receipt, 's3Key': key}
