import json
import os
import uuid
import boto3
from datetime import datetime, timezone

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['ORDERS_TABLE'])


def handler(event, context):
    order = event if isinstance(event, dict) else json.loads(event)

    required = ['customerName', 'items', 'totalAmount']
    for field in required:
        if field not in order:
            raise ValueError(f'Missing required field: {field}')

    if not isinstance(order['items'], list) or len(order['items']) == 0:
        raise ValueError('Items must be a non-empty list')

    if not isinstance(order['totalAmount'], (int, float)) or order['totalAmount'] <= 0:
        raise ValueError('Total amount must be positive')

    order_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    table.put_item(Item={
        'orderId': order_id,
        'customerName': order['customerName'],
        'items': json.dumps(order['items']),
        'totalAmount': str(order['totalAmount']),
        'status': 'VALIDATED',
        'createdAt': now,
    })

    return {
        'orderId': order_id,
        'customerName': order['customerName'],
        'items': order['items'],
        'totalAmount': order['totalAmount'],
        'status': 'VALIDATED',
        'createdAt': now,
    }
