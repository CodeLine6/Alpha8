import { config } from '../src/config/env.js';
import { fetchNewsHeadlines, classifySentiment, NewsSentimentFilter } from '../src/intelligence/news-sentiment.js';
import { initRedis, checkRedisHealth } from '../src/lib/redis.js';

async function runTest() {
    console.log('--- Testing News Sentiment Filter (Gemini) ---');

    if (!config.GEMINI_API_KEY || config.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        console.error('❌ ERROR: GEMINI_API_KEY is not set or is using the placeholder value in .env');
        process.exit(1);
    }

    console.log('✅ Gemini API Key detected.');
    const symbol = 'RELIANCE';

    try {
        console.log(`\n1. Testing Google News RSS Fetch for ${symbol}...`);
        const headlines = await fetchNewsHeadlines(symbol, 3);
        console.log(`📰 Fetched ${headlines.length} headlines:`);
        headlines.forEach((h, i) => console.log(`  ${i + 1}. ${h}`));

        console.log('\n2. Testing Gemini Sentiment Classification directly...');
        const sentimentResult = await classifySentiment(symbol, headlines, config.GEMINI_API_KEY);
        console.log('🧠 Gemini Response:');
        console.dir(sentimentResult, { depth: null, colors: true });

        console.log('\n3. Testing NewsSentimentFilter class integration (requires Redis)...');

        let redisConfig = null;
        try {
            redisConfig = initRedis(config.REDIS_URL);
            await redisConfig.connect();
            const healthy = await checkRedisHealth();
            if (!healthy) throw new Error('Redis not healthy');
            console.log('✅ Redis connected successfully.');
        } catch (e) {
            console.warn('⚠️ Could not connect to Redis, skipping full integration test.', e.message);
            process.exit(0);
        }

        const filter = new NewsSentimentFilter({
            redis: redisConfig,
            geminiApiKey: config.GEMINI_API_KEY,
            logger: (msg) => console.log(`[Logger]: ${msg}`) // mock logger to console
        });

        // Clear any previous block for testing
        await filter.unblock(symbol);

        console.log(`\nEvaluating BUY signal for ${symbol} via filter...`);
        const filterResult = await filter.check(symbol, 'BUY');

        console.log('\n🚦 Final Filter Check Result:');
        console.dir(filterResult, { depth: null, colors: true });

        process.exit(0);
    } catch (e) {
        console.error('\n❌ Test failed with error:', e.message);
        if (e.cause) console.error('Cause:', e.cause);
        process.exit(1);
    }
}

runTest();
