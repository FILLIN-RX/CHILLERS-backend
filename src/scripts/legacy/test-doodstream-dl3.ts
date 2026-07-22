import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

async function main() {
  const API_KEY = process.env.DOODSTREAM_API_KEY;
  const BASE_URL = 'https://doodapi.co/api';
  const fileCode = 'hz34fygr7sbr';

  // Test /file/info
  console.log('=== /file/info ===');
  try {
    const { data } = await axios.get(`${BASE_URL}/file/info`, {
      params: { key: API_KEY, file_code: fileCode },
      timeout: 10000,
    });
    console.log('Full response:', JSON.stringify(data, null, 2));
    const info = data.result?.[0];
    console.log('protected_dl:', info?.protected_dl);
    console.log('full dl URL:', `https://doodstream.com${info?.protected_dl}`);
  } catch (err: any) {
    console.error('Error:', err.message);
  }

  // Test /file/dl
  console.log('\n=== /file/dl ===');
  try {
    const { data } = await axios.get(`${BASE_URL}/file/dl`, {
      params: { key: API_KEY, file_code: fileCode },
      timeout: 10000,
    });
    console.log('Full response:', JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.error('Error:', err.message);
  }
}

main();
