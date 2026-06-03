import json
import os
import boto3
import requests

sns = boto3.client('sns')
secretsmanager = boto3.client('secretsmanager')

TOPIC_ARN = os.environ['NOTIFICATION_TOPIC_ARN']
WEBHOOK_SECRET_ARN = os.environ.get('WEBHOOK_SECRET_ARN', '')


def handler(event, context):
    message = {
        'type': 'ORDER_PROCESSED',
        'orderId': event['orderId'],
        'receiptId': event.get('receiptId', 'N/A'),
        'customerName': event['customerName'],
        'totalAmount': event['totalAmount'],
    }

    sns.publish(
        TopicArn=TOPIC_ARN,
        Subject=f"Order {event['orderId'][:8]} processed",
        Message=json.dumps(message, indent=2),
    )

    webhook_url = _get_webhook_url()
    if webhook_url:
        try:
            requests.post(webhook_url, json=message, timeout=5)
        except requests.RequestException:
            pass

    return {**message, 'notified': True}


def _get_webhook_url():
    if not WEBHOOK_SECRET_ARN:
        return None
    try:
        resp = secretsmanager.get_secret_value(SecretId=WEBHOOK_SECRET_ARN)
        return resp.get('SecretString', '')
    except Exception:
        return None
