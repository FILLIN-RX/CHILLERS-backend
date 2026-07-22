import doodClient from '../../modules/doodstream/doodstream.client';

async function main() {
  const fileCode = 'hz34fygr7sbr';

  // Test /file/info via doodClient
  console.log('=== /file/info via doodClient ===');
  try {
    const { data } = await doodClient.get('/file/info', { params: { file_code: fileCode } });
    console.log('Full data:', JSON.stringify(data, null, 2));
    const result = data.result;
    console.log('result type:', typeof result, Array.isArray(result));
    if (Array.isArray(result) && result.length > 0) {
      console.log('First item:', JSON.stringify(result[0], null, 2));
      console.log('protected_dl:', result[0].protected_dl);
    }
  } catch (err: any) {
    console.error('Error:', err.message, err.response?.data);
  }
}

main();
