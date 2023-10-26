import boto3

# Write a DynamodbRepository class for accessing DynamoDB.
# Use boto3.client('dynamodb') to create a client.
# get_item/put_item methods and error handling are required.

class DynamodbRepository:
    def __init__(self, table_name):
        self.client = boto3.client('dynamodb', region_name='us-east-1')
        self.table_name = table_name

    def get_item(self, table_name, key):
        try:
            response = self.client.get_item(TableName=self.table_name, Key=key)
            return response
        except Exception as e:
            print(e)
            return None

    def put_item(self, table_name, item):
        try:
            response = self.client.put_item(TableName=self.table_name, Item=item)
            return response
        except Exception as e:
            print(e)
            return None
    
    # Write delete_item method here.
    def delete_item(self, table_name, key):
        try:
            response = self.dynamodb_client.delete_item(TableName=self.table_name, Key=key)
            return response

# Write a handler for get user item from DynamoDB using DynamodbRepository.
# Trable name is 'users' and key is 'user_id'
def get_user_item(event, context):
    table_name = 'users'
    dynamodb_repository = DynamodbRepository(table_name)

    key = {'user_id': {'S': event['pathParameters']['user_id']}}
    user_item = dynamodb_repository.get_item(key)
    if user_item is not None:
        return {
            'statusCode': 200,
            'body': user_item
        }
    else:
        return {
            'statusCode': 404,
            'body': 'User not found'
        }