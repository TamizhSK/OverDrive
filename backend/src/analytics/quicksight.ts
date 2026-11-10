import {
  GenerateEmbedUrlForAnonymousUserCommand,
  GenerateEmbedUrlForRegisteredUserCommand,
  QuickSightClient,
} from '@aws-sdk/client-quicksight';

let client: QuickSightClient | undefined;
let clientRegion = '';

export async function advisorDashboardEmbedUrl(): Promise<string> {
  const accountId = process.env.AWS_ACCOUNT_ID;
  const dashboardId = process.env.QUICKSIGHT_DASHBOARD_ID;
  const allowedDomain = process.env.WEB_ORIGIN;
  const region = process.env.QUICKSIGHT_REGION ?? 'us-east-1';
  if (!accountId || !dashboardId || !allowedDomain) {
    throw new Error('Advisor analytics is not configured.');
  }
  if (!client || clientRegion !== region) {
    client = new QuickSightClient({ region });
    clientRegion = region;
  }

  const readerArn = process.env.QUICKSIGHT_EMBED_USER_ARN;
  if (readerArn) {
    const registered = await client.send(new GenerateEmbedUrlForRegisteredUserCommand({
      AwsAccountId: accountId,
      UserArn: readerArn,
      AllowedDomains: [allowedDomain],
      ExperienceConfiguration: { Dashboard: { InitialDashboardId: dashboardId } },
      SessionLifetimeInMinutes: 60,
    }));
    if (!registered.EmbedUrl) throw new Error('QuickSight did not return an embed URL.');
    return registered.EmbedUrl;
  }

  const response = await client.send(new GenerateEmbedUrlForAnonymousUserCommand({
    AwsAccountId: accountId,
    Namespace: 'default',
    AuthorizedResourceArns: [`arn:aws:quicksight:${region}:${accountId}:dashboard/${dashboardId}`],
    AllowedDomains: [allowedDomain],
    ExperienceConfiguration: { Dashboard: { InitialDashboardId: dashboardId } },
    SessionLifetimeInMinutes: 60,
  }));
  if (!response.EmbedUrl) throw new Error('QuickSight did not return an embed URL.');
  return response.EmbedUrl;
}
