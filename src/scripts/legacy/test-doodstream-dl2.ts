import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { getFileDownloadUrl } from '../../modules/doodstream/doodstream.service';

async function main() {
  const fileCode = 'hz34fygr7sbr'; // The Chi S08E01

  console.log(`Test getFileDownloadUrl for ${fileCode}...`);
  const url = await getFileDownloadUrl(fileCode);
  console.log('Result:', url);

  console.log(`\nTest getFileDownloadUrl for c54crk1xxqe4 (X-Men S02E01)...`);
  const url2 = await getFileDownloadUrl('c54crk1xxqe4');
  console.log('Result:', url2);
}

main().catch(err => console.error('[FATAL]', err));
