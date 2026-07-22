#!/bin/bash
cd /home/ruxel/CHILLERS/backend
npx tsx src/scripts/link-series-tmdb.ts >> /home/ruxel/CHILLERS/backend/cron-link-tmdb.log 2>&1
