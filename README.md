# WebApp CDK

CDK stack for deploying web applications to AWS using CloudFront.

## Architecture

Supports two hosting modes:

- **Static** — S3 + CloudFront with OAC. Works with any SPA or static export (React, Vue, Vite, Next.js static).
- **SSR** — Lambda (via AWS Lambda Web Adapter) + CloudFront Function URL origin. Works with Next.js standalone or similar.

Optionally provisions a **Cognito User Pool** for authentication (admin-only sign-up, email sign-in).

## Prerequisites

- Node.js
- AWS CDK CLI (`npm install -g aws-cdk`)
- AWS credentials configured
- `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` (or `AWS_ACCOUNT_ID` / `AWS_REGION`) environment variables set

## Usage

```bash
npm install
npm run build
npm run bootstrap   # first time only
npm run deploy
```

## Configuration

In `bin/app.ts`:

```ts
new WebAppStack(app, 'WebAppStack', {
  env,
  buildOutputPath: '../client/dist',  // path to your build output
  mode: 'static',                     // 'static' | 'ssr'
  enableAuth: true,                   // provisions Cognito User Pool
});
```

## Stack Outputs

| Output             | Description                    |
|--------------------|--------------------------------|
| DistributionUrl    | CloudFront distribution URL    |
| UserPoolId         | Cognito User Pool ID           |
| UserPoolClientId   | Cognito User Pool Client ID    |

## Cleanup

```bash
npm run destroy
```
