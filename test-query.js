import pg from 'pg';

const DATABASE_URL = 'postgresql://alpha8:alpha8_dev@localhost:5432/alpha8';
const { Client } = pg;

async function run() {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();

    try {
        await client.query('BEGIN');

        // Insert test data
        // RELIANCE - only BUY
        await client.query(`
      INSERT INTO trades (order_id, symbol, side, quantity, price, strategy, status, created_at)
      VALUES 
      ('TEST1', 'RELIANCE', 'BUY', 10, 2500, 'TestStrat', 'FILLED', NOW() - INTERVAL '2 hours')
    `);

        // TCS - BUY then SELL (Position closed)
        await client.query(`
      INSERT INTO trades (order_id, symbol, side, quantity, price, strategy, status, created_at)
      VALUES 
      ('TEST2', 'TCS', 'BUY', 10, 4000, 'TestStrat', 'FILLED', NOW() - INTERVAL '3 hours'),
      ('TEST3', 'TCS', 'SELL', 10, 4050, 'TestStrat', 'FILLED', NOW() - INTERVAL '1 hour')
    `);

        // INFY - BUY then SELL then BUY again (Position open)
        await client.query(`
      INSERT INTO trades (order_id, symbol, side, quantity, price, strategy, status, created_at)
      VALUES 
      ('TEST4', 'INFY', 'BUY', 10, 1500, 'TestStrat', 'FILLED', NOW() - INTERVAL '4 hours'),
      ('TEST5', 'INFY', 'SELL', 10, 1520, 'TestStrat', 'FILLED', NOW() - INTERVAL '2 hours'),
      ('TEST6', 'INFY', 'BUY', 10, 1515, 'TestStrat', 'FILLED', NOW() - INTERVAL '10 minutes')
    `);

        console.log("Inserted test data:");
        const allTrades = await client.query("SELECT symbol, side, price, to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI:SS') as time FROM trades WHERE order_id LIKE 'TEST%' ORDER BY created_at ASC");
        console.table(allTrades.rows);

        console.log("\\nRunning the hydratePositions query...");

        const result = await client.query(`
      SELECT symbol, price, quantity, strategy, created_at
      FROM (
        SELECT DISTINCT ON (symbol)
          symbol, side, price, quantity, strategy, created_at, id
        FROM trades
        WHERE status = 'FILLED'
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date =
              (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        ORDER BY symbol, created_at DESC, id DESC
      ) AS latest_trades
      WHERE side = 'BUY'
    `);

        console.log("\\nQuery Output (Active Positions):");
        console.table(result.rows.map(r => ({ ...r, created_at: r.created_at.toISOString() })));

        await client.query('ROLLBACK');
        console.log("\\nRolled back test data.");

    } catch (err) {
        console.error(err);
        await client.query('ROLLBACK');
    } finally {
        await client.end();
    }
}

run();
