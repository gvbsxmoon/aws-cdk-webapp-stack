import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

// ─────────────────────────────────────────────────────────────────────────────
// WebAppStack — Generic CloudFront-hosted web application stack.
//
// Supports two modes:
//   - "static" (default): Deploys a static SPA (React, Vue, Vite, Next.js
//     static export) to an S3 bucket behind CloudFront with OAC.
//   - "ssr": Deploys a server-rendered app (e.g. Next.js standalone) to a
//     Lambda function with the AWS Lambda Web Adapter, fronted by CloudFront
//     via a Lambda Function URL origin.
//
// Optionally provisions a Cognito User Pool for authentication. The pool is
// created with admin-only sign-up, email sign-in, and relaxed password policy.
// The app is responsible for integrating Cognito client-side (e.g. via
// amazon-cognito-identity-js or AWS Amplify) and protecting its own routes.
//
// Usage:
//   new WebAppStack(app, 'MyWebApp', {
//     env,
//     buildOutputPath: '../client/dist',     // path to build output
//     mode: 'static',                        // or 'ssr'
//     enableAuth: true,                      // provisions Cognito
//   });
// ─────────────────────────────────────────────────────────────────────────────

export type WebAppMode = 'static' | 'ssr';

export interface WebAppStackProps extends cdk.StackProps {
	/** Absolute or relative path to the web app build output folder. */
	buildOutputPath: string;

	/**
	 * Hosting mode.
	 * - "static": S3 + CloudFront (for any SPA or static export).
	 * - "ssr": Lambda + CloudFront (for Next.js standalone or similar).
	 * @default "static"
	 */
	mode?: WebAppMode;

	/**
	 * When true, provisions a Cognito User Pool and Client.
	 * The pool IDs are exported as stack outputs so the app can use them.
	 * @default false
	 */
	enableAuth?: boolean;
}

export class WebAppStack extends cdk.Stack {
	/** The CloudFront distribution serving the web app. */
	public readonly distribution: cloudfront.Distribution;

	/** The Cognito User Pool (only set when enableAuth is true). */
	public readonly userPool?: cognito.UserPool;

	/** The Cognito User Pool Client (only set when enableAuth is true). */
	public readonly userPoolClient?: cognito.UserPoolClient;

	constructor(scope: Construct, id: string, props: WebAppStackProps) {
		super(scope, id, props);

		const mode = props.mode ?? 'static';
		const enableAuth = props.enableAuth ?? false;

		// ── Origin: S3 (static) or Lambda Function URL (ssr) ─────────
		let origin: cloudfront.IOrigin;

		if (mode === 'static') {
			origin = this.createStaticOrigin(props.buildOutputPath);
		} else {
			origin = this.createSsrOrigin(props.buildOutputPath);
		}

		// ── CloudFront Distribution ──────────────────────────────────
		this.distribution = this.createDistribution(origin, mode);

		new cdk.CfnOutput(this, 'DistributionUrl', {
			value: `https://${this.distribution.domainName}`,
			description: 'CloudFront distribution URL',
		});

		// ── Cognito (optional) ───────────────────────────────────────
		if (enableAuth) {
			const { userPool, userPoolClient } = this.createAuth();
			this.userPool = userPool;
			this.userPoolClient = userPoolClient;
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Static mode: S3 bucket + OAC + BucketDeployment
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Creates an S3 bucket for static hosting and deploys the build output
	 * into it. Returns an S3OAC origin for CloudFront.
	 */
	private createStaticOrigin(buildOutputPath: string): cloudfront.IOrigin {
		const bucket = new s3.Bucket(this, 'WebAppBucket', {
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
		});

		new s3deploy.BucketDeployment(this, 'DeployWebApp', {
			sources: [s3deploy.Source.asset(buildOutputPath)],
			destinationBucket: bucket,
		});

		return origins.S3BucketOrigin.withOriginAccessControl(bucket);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// SSR mode: Lambda with Web Adapter + Function URL
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Creates a Lambda function running the SSR app via the AWS Lambda Web
	 * Adapter layer. Exposes a Function URL that CloudFront uses as origin.
	 */
	private createSsrOrigin(buildOutputPath: string): cloudfront.IOrigin {
		const webAdapterLayer = lambda.LayerVersion.fromLayerVersionArn(
			this,
			'WebAdapterLayer',
			`arn:aws:lambda:${this.region}:753240598075:layer:LambdaAdapterLayerArm64:25`,
		);

		const logGroup = new logs.LogGroup(this, 'SsrLogs', {
			logGroupName: `/webapp/${this.stackName}/ssr`,
			retention: logs.RetentionDays.ONE_MONTH,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});

		const fn = new lambda.Function(this, 'SsrFunction', {
			runtime: lambda.Runtime.NODEJS_22_X,
			architecture: lambda.Architecture.ARM_64,
			handler: 'run.sh',
			code: lambda.Code.fromAsset(buildOutputPath),
			memorySize: 2048,
			timeout: cdk.Duration.minutes(2),
			loggingFormat: lambda.LoggingFormat.JSON,
			logGroup,
			layers: [webAdapterLayer],
			environment: {
				AWS_LWA_ENABLE_COMPRESSION: 'true',
				AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
				AWS_LWA_INVOKE_MODE: 'response_stream',
				PORT: '8080',
			},
		});

		const fnUrl = fn.addFunctionUrl({
			authType: lambda.FunctionUrlAuthType.NONE,
			invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
		});

		return new origins.FunctionUrlOrigin(fnUrl);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// CloudFront Distribution
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Creates the CloudFront distribution. In static mode, configures SPA
	 * fallback (404 → /index.html). In SSR mode, forwards all requests
	 * to the Lambda origin.
	 */
	private createDistribution(origin: cloudfront.IOrigin, mode: WebAppMode): cloudfront.Distribution {
		const errorResponses: cloudfront.ErrorResponse[] =
			mode === 'static'
				? [
						{
							httpStatus: 403,
							responseHttpStatus: 200,
							responsePagePath: '/index.html',
							ttl: cdk.Duration.seconds(0),
						},
						{
							httpStatus: 404,
							responseHttpStatus: 200,
							responsePagePath: '/index.html',
							ttl: cdk.Duration.seconds(0),
						},
					]
				: [];

		return new cloudfront.Distribution(this, 'Distribution', {
			defaultBehavior: {
				origin,
				viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				allowedMethods: mode === 'ssr' ? cloudfront.AllowedMethods.ALLOW_ALL : cloudfront.AllowedMethods.ALLOW_GET_HEAD,
				cachePolicy: mode === 'ssr' ? cloudfront.CachePolicy.CACHING_DISABLED : cloudfront.CachePolicy.CACHING_OPTIMIZED,
				originRequestPolicy: mode === 'ssr' ? cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER : undefined,
			},
			defaultRootObject: mode === 'static' ? 'index.html' : undefined,
			errorResponses,
			minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
		});
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Cognito User Pool
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Provisions a Cognito User Pool with admin-only sign-up, email-based
	 * sign-in, and a relaxed password policy. Returns the pool and client
	 * so the app can integrate authentication on its own terms.
	 */
	private createAuth(): {
		userPool: cognito.UserPool;
		userPoolClient: cognito.UserPoolClient;
	} {
		const userPool = new cognito.UserPool(this, 'UserPool', {
			userPoolName: `${this.stackName}-users`,
			selfSignUpEnabled: false,
			signInAliases: { email: true },
			standardAttributes: {
				email: { required: true, mutable: false },
			},
			passwordPolicy: {
				minLength: 8,
				requireUppercase: false,
				requireLowercase: false,
				requireDigits: false,
				requireSymbols: false,
			},
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});

		const userPoolClient = userPool.addClient('WebAppClient', {
			userPoolClientName: `${this.stackName}-client`,
			authFlows: {
				userPassword: true,
				userSrp: true,
			},
		});

		new cdk.CfnOutput(this, 'UserPoolId', {
			value: userPool.userPoolId,
			description: 'Cognito User Pool ID',
		});

		new cdk.CfnOutput(this, 'UserPoolClientId', {
			value: userPoolClient.userPoolClientId,
			description: 'Cognito User Pool Client ID',
		});

		return { userPool, userPoolClient };
	}
}
