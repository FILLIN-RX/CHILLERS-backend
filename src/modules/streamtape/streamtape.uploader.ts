import { StreamtapeClient } from './streamtape.client';

function getClient(): StreamtapeClient | null {
  const login = process.env.STREAMTAPE_LOGIN;
  const key = process.env.STREAMTAPE_KEY;
  if (!login || !key) return null;
  return new StreamtapeClient(login, key);
}

const POLL_INTERVAL = 5000;
const MAX_POLLS = 60;

async function pollRemoteUpload(client: StreamtapeClient, remoteId: string): Promise<string | null> {
  for (let i = 0; i < MAX_POLLS; i++) {
    try {
      const status = await client.getRemoteUploadStatus(remoteId);
      const entry = (status as any)[remoteId];
      if (!entry) {
        console.log(`[StreamtapeUpload] No status entry yet for ${remoteId}, retrying...`);
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        continue;
      }
      if (entry.status === 'finished') {
        console.log(`[StreamtapeUpload] Upload finished: ${remoteId} → extid=${entry.extid}`);
        return entry.extid;
      }
      if (entry.status === 'error' || entry.status === 'aborted') {
        console.log(`[StreamtapeUpload] Upload failed: ${remoteId} status=${entry.status}`);
        return null;
      }
      console.log(`[StreamtapeUpload] Upload ${remoteId}: status=${entry.status} (${i + 1}/${MAX_POLLS})`);
    } catch (e: any) {
      console.log(`[StreamtapeUpload] Poll error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  console.log(`[StreamtapeUpload] Timeout waiting for ${remoteId}`);
  return null;
}

export async function uploadToStreamtape(
  directUrl: string,
  title: string,
): Promise<{ linkId: string; embedUrl: string; directLink: string } | null> {
  const client = getClient();
  if (!client) {
    console.log('[StreamtapeUpload] STREAMTAPE_LOGIN/KEY manquants — skip');
    return null;
  }

  try {
    console.log(`[StreamtapeUpload] Starting remote upload: "${title}"`);
    const result = await client.addRemoteUpload(directUrl, undefined, title);
    const remoteId = (result as any).id;
    if (!remoteId) {
      console.log(`[StreamtapeUpload] No remote id returned for "${title}"`);
      return null;
    }

    const extid = await pollRemoteUpload(client, remoteId);
    if (!extid) return null;

    const embedUrl = `https://streamtape.com/e/${extid}`;
    const directLink = `https://streamtape.com/v/${extid}/${encodeURIComponent(title)}`;

    console.log(`[StreamtapeUpload] ✅ "${title}" → embed=${embedUrl}`);
    return { linkId: extid, embedUrl, directLink };
  } catch (e: any) {
    console.log(`[StreamtapeUpload] Upload failed for "${title}": ${e.message}`);
    return null;
  }
}

export async function isUqloadFull(): Promise<boolean> {
  const apiKey = process.env.UQLOAD_API_KEY;
  if (!apiKey) return false;

  try {
    const { UqloadClient } = await import('../uqload/uqload.client');
    const client = new UqloadClient(apiKey);
    const res = await client.getAccountInfo();
    const used = parseInt((res.result as any).storage_used, 10);
    const left = (res.result as any).storage_left;
    console.log(`[Uqload] Storage: ${used}GB used, ${left}GB left`);
    return used >= 3000 || left <= 0;
  } catch (e: any) {
    console.log(`[Uqload] Storage check failed: ${e.message}`);
    return false;
  }
}
