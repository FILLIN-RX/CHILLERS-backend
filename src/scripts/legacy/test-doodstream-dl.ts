import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const API_KEY = process.env.DOODSTREAM_API_KEY;
const BASE_URL = 'https://doodapi.co/api';

async function main() {
  const fileCode = 'hz34fygr7sbr'; // The Chi S08E01

  console.log('1. Test /file/info...');
  try {
    const { data } = await axios.get(`${BASE_URL}/file/info`, {
      params: { key: API_KEY, file_code: fileCode },
      timeout: 10000,
    });
    console.log('   Result:', JSON.stringify(data, null, 2).slice(0, 300));
  } catch (err: any) {
    console.error('   FAIL:', err.message);
  }

  console.log('\n2. Test /file/dl...');
  try {
    const { data } = await axios.get(`${BASE_URL}/file/dl`, {
      params: { key: API_KEY, file_code: fileCode },
      timeout: 10000,
    });
    console.log('   Result:', JSON.stringify(data, null, 2).slice(0, 300));
  } catch (err: any) {
    console.error('   FAIL:', err.message);
  }

  console.log('\n3. Test /file/check...');
  try {
    const { data } = await axios.get(`${BASE_URL}/file/check`, {
      params: { key: API_KEY, file_code: fileCode },
      timeout: 10000,
    });
    console.log('   Result:', JSON.stringify(data, null, 2).slice(0, 300));
  } catch (err: any) {
    console.error('   FAIL:', err.message);
  }
}

main().catch(err => console.error('[FATAL]', err));
