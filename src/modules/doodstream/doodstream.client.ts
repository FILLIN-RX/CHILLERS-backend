import axios from 'axios';

const BASE_URL = 'https://doodapi.co/api';

const doodClient = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
});

// Ajouter la clé API à chaque requête (lecture paresseuse pour dotenv)
doodClient.interceptors.request.use((config) => {
  const key = process.env.DOODSTREAM_API_KEY;
  if (key) {
    config.params = { ...config.params, key };
  }
  return config;
});

doodClient.interceptors.response.use(
  (res) => res,
  (err) => {
    const msg = err.response?.data?.msg || err.message;
    console.error(`[DoodStream] ${msg}`);
    throw err;
  }
);

export default doodClient;
