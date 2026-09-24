import { CredentialCapturePage } from "../../../components/app/credential-capture";

export default async function Page({
  params,
}: PageProps<"/credential-capture/[captureId]">) {
  const { captureId } = await params;
  return <CredentialCapturePage captureId={captureId} />;
}
