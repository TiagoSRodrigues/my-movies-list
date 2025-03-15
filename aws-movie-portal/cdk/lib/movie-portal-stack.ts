import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';

export class MoviePortalInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 Bucket para armazenar imagens de filmes e outros ativos
    const assetsBucket = new s3.Bucket(this, 'MovieAssetsBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'],
          maxAge: 3000,
        },
      ],
    });

    // DynamoDB Table para armazenar informações de filmes
    const moviesTable = new dynamodb.Table(this, 'MoviesTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'title', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Adicionar GSI para pesquisa por gênero
    moviesTable.addGlobalSecondaryIndex({
      indexName: 'GenreIndex',
      partitionKey: { name: 'genre', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'rating', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Cognito User Pool para autenticação
    const userPool = new cognito.UserPool(this, 'MoviePortalUserPool', {
      selfSignUpEnabled: true,
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'MoviePortalUserPoolClient', {
      userPool,
      generateSecret: false,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
    });

    // AppSync GraphQL API
    const api = new appsync.GraphqlApi(this, 'MoviePortalAPI', {
      name: 'movie-portal-api',
      schema: appsync.SchemaFile.fromAsset('graphql/schema.graphql'),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: {
            userPool,
          },
        },
        additionalAuthorizationModes: [
          {
            authorizationType: appsync.AuthorizationType.API_KEY,
            apiKeyConfig: {
              name: 'default',
              description: 'default api key',
              expires: cdk.Expiration.after(cdk.Duration.days(365)),
            },
          },
        ],
      },
    });

    // SQS Queue para processamento de filmes
    const movieProcessingQueue = new sqs.Queue(this, 'MovieProcessingQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(14),
    });

    // SNS Topic para notificações
    const movieNotificationTopic = new sns.Topic(this, 'MovieNotificationTopic', {
      displayName: 'Movie Processing Notifications',
    });

    // Lambda para processar requisições de API
    const apiLambda = new lambda.Function(this, 'MovieApiHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/api'),
      environment: {
        MOVIES_TABLE: moviesTable.tableName,
        ASSETS_BUCKET: assetsBucket.bucketName,
        PROCESSING_QUEUE_URL: movieProcessingQueue.queueUrl,
        NOTIFICATION_TOPIC_ARN: movieNotificationTopic.topicArn,
      },
    });

    // Conceder permissões ao Lambda
    moviesTable.grantReadWriteData(apiLambda);
    assetsBucket.grantReadWrite(apiLambda);
    movieProcessingQueue.grantSendMessages(apiLambda);
    movieNotificationTopic.grantPublish(apiLambda);

    // REST API Gateway
    const restApi = new apigateway.RestApi(this, 'MoviePortalRestApi', {
      description: 'API for Movie Portal',
      deployOptions: {
        stageName: 'dev',
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    const moviesResource = restApi.root.addResource('movies');
    const movieIntegration = new apigateway.LambdaIntegration(apiLambda);
    
    moviesResource.addMethod('GET', movieIntegration);
    moviesResource.addMethod('POST', movieIntegration);
    
    const singleMovieResource = moviesResource.addResource('{id}');
    singleMovieResource.addMethod('GET', movieIntegration);
    singleMovieResource.addMethod('PUT', movieIntegration);
    singleMovieResource.addMethod('DELETE', movieIntegration);

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'GraphQLApiUrl', { value: api.graphqlUrl });
    new cdk.CfnOutput(this, 'GraphQLApiKey', { value: api.apiKey || '' });
    new cdk.CfnOutput(this, 'RestApiUrl', { value: restApi.url });
    new cdk.CfnOutput(this, 'AssetsBucketName', { value: assetsBucket.bucketName });
    new cdk.CfnOutput(this, 'MoviesTableName', { value: moviesTable.tableName });
    new cdk.CfnOutput(this, 'ProcessingQueueUrl', { value: movieProcessingQueue.queueUrl });
    new cdk.CfnOutput(this, 'NotificationTopicArn', { value: movieNotificationTopic.topicArn });
  }
}