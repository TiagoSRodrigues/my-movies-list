const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const sqs = new AWS.SQS();
const sns = new AWS.SNS();
const s3 = new AWS.S3();

// Environment variables
const MOVIES_TABLE = process.env.MOVIES_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;
const PROCESSING_QUEUE_URL = process.env.PROCESSING_QUEUE_URL;
const NOTIFICATION_TOPIC_ARN = process.env.NOTIFICATION_TOPIC_ARN;
const ASSETS_BUCKET = process.env.ASSETS_BUCKET;

// Helper functions
const getCorsHeaders = () => {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Methods': 'OPTIONS,GET,POST,PUT,DELETE',
        'Content-Type': 'application/json'
    };
};

const buildResponse = (statusCode, body) => {
    return {
        statusCode,
        headers: getCorsHeaders(),
        body: JSON.stringify(body)
    };
};

// Main handler function
exports.handler = async (event) => {
    console.log('Event: ', JSON.stringify(event));

    // Handle OPTIONS requests for CORS
    if (event.httpMethod === 'OPTIONS') {
        return buildResponse(200, {});
    }

    try {
        const { httpMethod, resource, path, pathParameters, queryStringParameters, body } = event;
        const parsedBody = body ? JSON.parse(body) : {};

        // Extract user ID from Authorization header or request context
        const userId = event.requestContext?.authorizer?.claims?.sub || 'anonymous';

        // Movie Operations
        if (path.startsWith('/movies') || resource.startsWith('/movies')) {
            // GET /movies - List all movies
            if (httpMethod === 'GET' && (resource === '/movies' || path === '/movies')) {
                const params = {
                    TableName: MOVIES_TABLE,
                    Limit: queryStringParameters?.limit || 50
                };

                if (queryStringParameters?.genre) {
                    params.IndexName = 'GenreIndex';
                    params.KeyConditionExpression = 'genre = :genre';
                    params.ExpressionAttributeValues = {
                        ':genre': queryStringParameters.genre
                    };
                }

                if (queryStringParameters?.nextToken) {
                    params.ExclusiveStartKey = JSON.parse(
                        Buffer.from(queryStringParameters.nextToken, 'base64').toString()
                    );
                }

                const result = await dynamodb.query(params).promise();

                // Create pagination token if needed
                let nextToken = null;
                if (result.LastEvaluatedKey) {
                    nextToken = Buffer.from(
                        JSON.stringify(result.LastEvaluatedKey)
                    ).toString('base64');
                }

                return buildResponse(200, {
                    items: result.Items,
                    nextToken
                });
            }

            // GET /movies/{id} - Get a specific movie
            if (httpMethod === 'GET' && (resource === '/movies/{id}' || path.match(/\/movies\/[\w-]+$/))) {
                const id = pathParameters?.id || path.split('/').pop();

                const result = await dynamodb.get({
                    TableName: MOVIES_TABLE,
                    Key: { id }
                }).promise();

                if (!result.Item) {
                    return buildResponse(404, { message: 'Movie not found' });
                }

                return buildResponse(200, result.Item);
            }

            // POST /movies - Create a new movie
            if (httpMethod === 'POST' && (resource === '/movies' || path === '/movies')) {
                // Generate unique ID
                const id = uuidv4();
                const timestamp = new Date().toISOString();

                // Basic validation
                if (!parsedBody.title) {
                    return buildResponse(400, { message: 'Title is required' });
                }

                // Prepare movie item
                const movieItem = {
                    id,
                    userId,
                    title: parsedBody.title,
                    year: parsedBody.year || null,
                    genre: parsedBody.genre || null,
                    director: parsedBody.director || null,
                    synopsis: parsedBody.synopsis || null,
                    rating: parsedBody.rating || null,
                    watchedDate: parsedBody.watchedDate || timestamp,
                    imageUrl: parsedBody.imageUrl || null,
                    actors: parsedBody.actors || [],
                    createdAt: timestamp,
                    updatedAt: timestamp
                };

                // Save basic movie info to DynamoDB
                await dynamodb.put({
                    TableName: MOVIES_TABLE,
                    Item: movieItem
                }).promise();

                // Send to SQS for further processing
                await sqs.sendMessage({
                    QueueUrl: PROCESSING_QUEUE_URL,
                    MessageBody: JSON.stringify({
                        movieId: id,
                        action: 'PROCESS_MOVIE',
                        payload: movieItem
                    }),
                    MessageAttributes: {
                        'MessageType': {
                            DataType: 'String',
                            StringValue: 'MovieProcessing'
                        }
                    }
                }).promise();

                // Send notification about new movie
                await sns.publish({
                    TopicArn: NOTIFICATION_TOPIC_ARN,
                    Message: JSON.stringify({
                        type: 'NEW_MOVIE_ADDED',
                        movie: movieItem
                    }),
                    Subject: 'New Movie Added: ' + movieItem.title
                }).promise();

                return buildResponse(201, movieItem);
            }

            // PUT /movies/{id} - Update a movie
            if (httpMethod === 'PUT' && (resource === '/movies/{id}' || path.match(/\/movies\/[\w-]+$/))) {
                const id = pathParameters?.id || path.split('/').pop();
                const timestamp = new Date().toISOString();

                // Check if movie exists
                const existingMovie = await dynamodb.get({
                    TableName: MOVIES_TABLE,
                    Key: { id }
                }).promise();

                if (!existingMovie.Item) {
                    return buildResponse(404, { message: 'Movie not found' });
                }

                // Prevent unauthorized updates
                if (existingMovie.Item.userId !== userId && userId !== 'admin') {
                    return buildResponse(403, { message: 'Not authorized to update this movie' });
                }

                // Build update expression
                const updateExpressionParts = [];
                const expressionAttributeValues = {};
                const expressionAttributeNames = {};

                // Only update fields that are provided
                const updatableFields = [
                    'title', 'year', 'genre', 'director', 'synopsis',
                    'rating', 'watchedDate', 'imageUrl', 'actors'
                ];

                updatableFields.forEach(field => {
                    if (parsedBody[field] !== undefined) {
                        updateExpressionParts.push(`#${field} = :${field}`);
                        expressionAttributeValues[`:${field}`] = parsedBody[field];
                        expressionAttributeNames[`#${field}`] = field;
                    }
                });

                // Always update the updatedAt timestamp
                updateExpressionParts.push('#updatedAt = :updatedAt');
                expressionAttributeValues[':updatedAt'] = timestamp;
                expressionAttributeNames['#updatedAt'] = 'updatedAt';

                if (updateExpressionParts.length === 0) {
                    return buildResponse(400, { message: 'No valid fields to update' });
                }

                const updateExpression = 'SET ' + updateExpressionParts.join(', ');

                // Update the movie in DynamoDB
                const result = await dynamodb.update({
                    TableName: MOVIES_TABLE,
                    Key: { id },
                    UpdateExpression: updateExpression,
                    ExpressionAttributeValues: expressionAttributeValues,
                    ExpressionAttributeNames: expressionAttributeNames,
                    ReturnValues: 'ALL_NEW'
                }).promise();

                // Check if we need to reprocess the movie
                if (parsedBody.title || parsedBody.year) {
                    await sqs.sendMessage({
                        QueueUrl: PROCESSING_QUEUE_URL,
                        MessageBody: JSON.stringify({
                            movieId: id,
                            action: 'PROCESS_MOVIE',
                            payload: result.Attributes
                        })
                    }).promise();
                }

                return buildResponse(200, result.Attributes);
            }

            // DELETE /movies/{id} - Delete a movie
            if (httpMethod === 'DELETE' && (resource === '/movies/{id}' || path.match(/\/movies\/[\w-]+$/))) {
                const id = pathParameters?.id || path.split('/').pop();

                // Check if movie exists and belongs to user
                const existingMovie = await dynamodb.get({
                    TableName: MOVIES_TABLE,
                    Key: { id }
                }).promise();

                if (!existingMovie.Item) {
                    return buildResponse(404, { message: 'Movie not found' });
                }

                // Prevent unauthorized deletions
                if (existingMovie.Item.userId !== userId && userId !== 'admin') {
                    return buildResponse(403, { message: 'Not authorized to delete this movie' });
                }

                // Delete the movie
                await dynamodb.delete({
                    TableName: MOVIES_TABLE,
                    Key: { id }
                }).promise();

                // Clean up related resources
                if (existingMovie.Item.imageUrl && existingMovie.Item.imageUrl.includes(ASSETS_BUCKET)) {
                    try {
                        const key = existingMovie.Item.imageUrl.split('/').pop();
                        await s3.deleteObject({
                            Bucket: ASSETS_BUCKET,
                            Key: key
                        }).promise();
                    } catch (error) {
                        console.error('Error deleting S3 object:', error);
                        // Continue with the delete operation even if S3 cleanup fails
                    }
                }

                return buildResponse(200, { message: 'Movie deleted successfully' });
            }
        }

        // User Operations
        if (path.startsWith('/users') || resource.startsWith('/users')) {
            // GET /users/{id} - Get user profile
            if (httpMethod === 'GET' && (resource === '/users/{id}' || path.match(/\/users\/[\w-]+$/))) {
                const id = pathParameters?.id || path.split('/').pop();

                // Users can only access their own profile
                if (id !== userId && userId !== 'admin') {
                    return buildResponse(403, { message: 'Not authorized to view this user profile' });
                }

                const result = await dynamodb.get({
                    TableName: USERS_TABLE,
                    Key: { id }
                }).promise();

                if (!result.Item) {
                    return buildResponse(404, { message: 'User not found' });
                }

                // Remove sensitive information
                delete result.Item.password;

                return buildResponse(200, result.Item);
            }

            // PUT /users/{id} - Update user profile
            if (httpMethod === 'PUT' && (resource === '/users/{id}' || path.match(/\/users\/[\w-]+$/))) {
                const id = pathParameters?.id || path.split('/').pop();

                // Users can only update their own profile
                if (id !== userId && userId !== 'admin') {
                    return buildResponse(403, { message: 'Not authorized to update this user profile' });
                }

                // Build update expression
                const updateExpressionParts = [];
                const expressionAttributeValues = {};
                const expressionAttributeNames = {};

                // Only update fields that are provided
                const updatableFields = [
                    'username', 'email', 'favoriteGenres', 'preferences'
                ];

                updatableFields.forEach(field => {
                    if (parsedBody[field] !== undefined) {
                        updateExpressionParts.push(`#${field} = :${field}`);
                        expressionAttributeValues[`:${field}`] = parsedBody[field];
                        expressionAttributeNames[`#${field}`] = field;
                    }
                });

                // Always update the updatedAt timestamp
                updateExpressionParts.push('#updatedAt = :updatedAt');
                expressionAttributeValues[':updatedAt'] = new Date().toISOString();
                expressionAttributeNames['#updatedAt'] = 'updatedAt';

                if (updateExpressionParts.length === 0) {
                    return buildResponse(400, { message: 'No valid fields to update' });
                }

                const updateExpression = 'SET ' + updateExpressionParts.join(', ');

                // Update the user in DynamoDB
                const result = await dynamodb.update({
                    TableName: USERS_TABLE,
                    Key: { id },
                    UpdateExpression: updateExpression,
                    ExpressionAttributeValues: expressionAttributeValues,
                    ExpressionAttributeNames: expressionAttributeNames,
                    ReturnValues: 'ALL_NEW'
                }).promise();

                // Remove sensitive information
                delete result.Attributes.password;

                return buildResponse(200, result.Attributes);
            }

            // GET /users/{id}/movies - Get user's movies
            if (httpMethod === 'GET' && (resource === '/users/{id}/movies' || path.match(/\/users\/[\w-]+\/movies$/))) {
                const id = pathParameters?.id || path.split('/').slice(-2)[0];

                // Users can only access their own movies
                if (id !== userId && userId !== 'admin') {
                    return buildResponse(403, { message: 'Not authorized to view this user\'s movies' });
                }

                const params = {
                    TableName: MOVIES_TABLE,
                    IndexName: 'UserIdIndex',
                    KeyConditionExpression: 'userId = :userId',
                    ExpressionAttributeValues: {
                        ':userId': id
                    },
                    Limit: queryStringParameters?.limit || 50
                };

                if (queryStringParameters?.nextToken) {
                    params.ExclusiveStartKey = JSON.parse(
                        Buffer.from(queryStringParameters.nextToken, 'base64').toString()
                    );
                }

                const result = await dynamodb.query(params).promise();

                // Create pagination token if needed
                let nextToken = null;
                if (result.LastEvaluatedKey) {
                    nextToken = Buffer.from(
                        JSON.stringify(result.LastEvaluatedKey)
                    ).toString('base64');
                }

                return buildResponse(200, {
                    items: result.Items,
                    nextToken
                });
            }
        }

        // S3 Presigned URL Generation
        if (path === '/presigned-url' || resource === '/presigned-url') {
            if (httpMethod === 'POST') {
                if (!parsedBody.filename) {
                    return buildResponse(400, { message: 'Filename is required' });
                }

                // Generate a unique filename
                const key = `${userId}/${uuidv4()}-${parsedBody.filename}`;
                const contentType = parsedBody.contentType || 'image/jpeg';

                // Generate presigned URL
                const presignedUrl = s3.getSignedUrl('putObject', {
                    Bucket: ASSETS_BUCKET,
                    Key: key,
                    ContentType: contentType,
                    Expires: 300 // URL válida por 5 minutos
                });

                return buildResponse(200, { presignedUrl, key });
            }
        }

        // Se a requisição não corresponder a nenhuma rota conhecida
        return buildResponse(404, { message: 'Route not found' });
    } catch (error) {
        console.error('Error: ', error);
        return buildResponse(500, { message: 'Internal server error', error: error.message });
    }
};