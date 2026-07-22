#!/bin/bash
cd /home/ruxel/CHILLERS/backend

# Lier les séries
npx tsx src/scripts/link-series-tmdb.ts >> /home/ruxel/CHILLERS/backend/cron-link-series.log 2>&1

# Lier les films
npx tsx src/scripts/link-movies-tmdb.ts >> /home/ruxel/CHILLERS/backend/cron-link-movies.log 2>&1
