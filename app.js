const http = require('http');
const https = require('https');
const fetchUrl = (url, follow = true) => new Promise((resolve, reject) => {
    const options = {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0' },
        timeout: 10000 // Timeout de 10 secondes pour éviter l'attente infinie
    };

    const req = https.get(url, options, (res) => {
        // Gérer les redirections (301, 302)
        if (follow && (res.statusCode === 301 || res.statusCode === 302)) {
            return resolve(fetchUrl(res.headers.location, false));
        }

        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error("Timeout dépassé")); });
});

const server = http.createServer(async (req, res) => {
    // Autoriser le CORS
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url.startsWith('/api/video')) {
        const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
        const pageUrl = urlParams.get('url');

        try {
            console.log("Tentative de récupération :", pageUrl);
            
            // 1. Récupérer le HTML de la page OpenOtaku
            const html = await fetchUrl(pageUrl);
            
            // Chercher l'iframe
            const match = html.match(/src="(https:\/\/vidzy\.cc\/embed-[^"]+)"/);
            if (!match) throw new Error("Iframe introuvable");
            const embedUrl = match[1];
            console.log("Embed trouvé :", embedUrl);

            // 2. Appel à l'API fs-dl
            const apiData = await fetchUrl(`https://www.open-otaku.me/api/fs-dl?url=${encodeURIComponent(embedUrl)}`);
            
            // Chercher le lien de téléchargement
            const linkMatch = apiData.match(/href="([^"]+)" id="fs-dl-link"/);
            if (!linkMatch) throw new Error("Lien téléchargement introuvable");
            
            const videoUrl = linkMatch[1];
            console.log("Lien trouvé :", videoUrl);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ videoUrl }));

        } catch (e) {
            console.error("Erreur serveur :", e.message);
            res.writeHead(500); 
            res.end(JSON.stringify({ error: e.message }));
        }
    } else {
        // ... (votre code HTML reste le même)
    }
});

server.listen(3000, () => console.log('Serveur sur http://localhost:3000'));