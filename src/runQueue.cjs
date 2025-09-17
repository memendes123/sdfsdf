const { randomUUID } = require('crypto');

const db = require('./db.cjs');

const DEFAULT_DURATION_MS = 12 * 60 * 1000; // 12 minutos de fallback

function parseJSON(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function mapQueueRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.userId,
    command: row.command,
    status: row.status,
    maxCommentsPerAccount: row.maxCommentsPerAccount != null ? Number(row.maxCommentsPerAccount) : 1000,
    accountLimit: row.accountLimit != null ? Number(row.accountLimit) : 100,
    enqueuedAt: row.enqueuedAt,
    startedAt: row.startedAt || null,
    finishedAt: row.finishedAt || null,
    durationMs: row.durationMs != null ? Number(row.durationMs) : null,
    creditsConsumed: row.creditsConsumed != null ? Number(row.creditsConsumed) : 0,
    totalComments: row.totalComments != null ? Number(row.totalComments) : 0,
    summary: parseJSON(row.summary),
    cleanup: parseJSON(row.cleanup),
    error: row.error || null,
  };
}

function mapQueueRowWithUser(row, { includeSensitive = false } = {}) {
  const job = mapQueueRow(row);
  if (!job || row == null) {
    return job;
  }

  job.user = {
    id: row.userId,
    username: row.userUsername || null,
    fullName: row.userFullName || null,
    role: row.userRole || null,
    status: row.userStatus || null,
  };

  if (row.userCredits != null) {
    job.user.credits = Number(row.userCredits);
  }

  if (Object.prototype.hasOwnProperty.call(row, 'userDiscordWebhookUrl')) {
    job.user.discordWebhookUrl = row.userDiscordWebhookUrl || '';
  }

  if (includeSensitive && Object.prototype.hasOwnProperty.call(row, 'userRep4repKey')) {
    job.user.rep4repKey = row.userRep4repKey || '';
  }

  return job;
}

function sanitizeLimit(value, fallback, max) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(num)));
}

async function enqueueJob({ userId, command = 'autoRun', maxCommentsPerAccount = 1000, accountLimit = 100 }) {
  if (!userId) {
    throw new Error('userId obrigatório para enfileirar execução.');
  }

  const connection = await db.getConnection();
  const existing = await connection.get(
    `SELECT q.*, u.username AS userUsername, u.fullName AS userFullName, u.role AS userRole, u.status AS userStatus,
            u.discordWebhookUrl AS userDiscordWebhookUrl,
            u.credits AS userCredits
       FROM run_queue q
       LEFT JOIN app_user u ON u.id = q.userId
      WHERE q.userId = ? AND q.status IN ('pending','running')
      ORDER BY datetime(q.enqueuedAt)
      LIMIT 1`,
    [userId],
  );

  if (existing) {
    return { alreadyQueued: true, job: mapQueueRowWithUser(existing) };
  }

  const id = randomUUID();
  const enqueuedAt = new Date().toISOString();
  const sanitizedMax = sanitizeLimit(maxCommentsPerAccount, 1000, 1000);
  const sanitizedAccounts = sanitizeLimit(accountLimit, 100, 100);

  await connection.run(
    `INSERT INTO run_queue (id, userId, command, status, maxCommentsPerAccount, accountLimit, enqueuedAt)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    [id, userId, command || 'autoRun', sanitizedMax, sanitizedAccounts, enqueuedAt],
  );

  const inserted = await connection.get(
    `SELECT q.*, u.username AS userUsername, u.fullName AS userFullName, u.role AS userRole, u.status AS userStatus,
            u.discordWebhookUrl AS userDiscordWebhookUrl,
            u.credits AS userCredits
       FROM run_queue q
       LEFT JOIN app_user u ON u.id = q.userId
      WHERE q.id = ?`,
    [id],
  );

  return { alreadyQueued: false, job: mapQueueRowWithUser(inserted) };
}

async function countActiveJobs(connection) {
  const row = await connection.get(
    `SELECT COUNT(*) AS count FROM run_queue WHERE status IN ('pending','running')`,
  );
  return row?.count ? Number(row.count) : 0;
}

async function computeAverageDuration(connection) {
  const row = await connection.get(
    `SELECT AVG(durationMs) AS avgDuration
       FROM (
         SELECT durationMs
           FROM run_queue
          WHERE status = 'completed' AND durationMs IS NOT NULL AND durationMs > 0
          ORDER BY datetime(finishedAt) DESC
          LIMIT 20
       )`,
  );
  return row?.avgDuration ? Number(row.avgDuration) : 0;
}

async function getUserQueueStatus(userId) {
  if (!userId) {
    return { queued: false, queueLength: 0 };
  }

  const connection = await db.getConnection();
  const row = await connection.get(
    `SELECT q.*, u.username AS userUsername, u.fullName AS userFullName, u.role AS userRole,
            u.status AS userStatus, u.discordWebhookUrl AS userDiscordWebhookUrl,
            u.credits AS userCredits
       FROM run_queue q
       LEFT JOIN app_user u ON u.id = q.userId
      WHERE q.userId = ? AND q.status IN ('pending','running')
      ORDER BY datetime(q.enqueuedAt)
      LIMIT 1`,
    [userId],
  );

  const queueLength = await countActiveJobs(connection);
  const averageDuration = await computeAverageDuration(connection);
  const fallbackDuration = averageDuration > 0 ? averageDuration : DEFAULT_DURATION_MS;

  if (!row) {
    return {
      queued: false,
      queueLength,
      averageDurationMs: averageDuration,
    };
  }

  const job = mapQueueRowWithUser(row);

  const aheadRow = await connection.get(
    `SELECT COUNT(*) AS count
       FROM run_queue
      WHERE status IN ('pending','running')
        AND (
          datetime(enqueuedAt) < datetime(?)
          OR (datetime(enqueuedAt) = datetime(?) AND id <> ? AND status = 'running')
        )`,
    [row.enqueuedAt, row.enqueuedAt, row.id],
  );

  const jobsAhead = aheadRow?.count ? Number(aheadRow.count) : 0;
  let estimatedWaitMs = jobsAhead * fallbackDuration;

  const runningRow = await connection.get(
    `SELECT id, startedAt
       FROM run_queue
      WHERE status = 'running'
      ORDER BY datetime(startedAt)
      LIMIT 1`,
  );

  if (row.status === 'running') {
    const startedAt = row.startedAt ? new Date(row.startedAt).getTime() : null;
    if (startedAt) {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(fallbackDuration - elapsed, Math.min(fallbackDuration, 2 * 60 * 1000));
      estimatedWaitMs = Math.max(remaining, 15 * 1000);
    } else {
      estimatedWaitMs = fallbackDuration;
    }
  } else if (runningRow && runningRow.id !== row.id) {
    const startedAt = runningRow.startedAt ? new Date(runningRow.startedAt).getTime() : null;
    if (startedAt) {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(fallbackDuration - elapsed, Math.min(fallbackDuration, 2 * 60 * 1000));
      estimatedWaitMs += Math.max(remaining, 15 * 1000);
    } else {
      estimatedWaitMs += fallbackDuration;
    }
  }

  const estimatedStartAt = new Date(Date.now() + estimatedWaitMs).toISOString();

  return {
    queued: true,
    job,
    queueLength,
    position: jobsAhead + 1,
    jobsAhead,
    averageDurationMs: averageDuration,
    estimatedWaitMs,
    estimatedStartAt,
  };
}

async function getQueueSnapshot() {
  const connection = await db.getConnection();
  const activeRows = await connection.all(
    `SELECT q.*, u.username AS userUsername, u.fullName AS userFullName, u.role AS userRole,
            u.status AS userStatus, u.discordWebhookUrl AS userDiscordWebhookUrl,
            u.credits AS userCredits
       FROM run_queue q
       LEFT JOIN app_user u ON u.id = q.userId
      WHERE q.status IN ('pending','running')
      ORDER BY datetime(q.enqueuedAt)`,
  );

  const jobs = activeRows.map((row, index) => {
    const job = mapQueueRowWithUser(row);
    job.position = index + 1;
    return job;
  });

  const historyRows = await connection.all(
    `SELECT q.*, u.username AS userUsername, u.fullName AS userFullName,
            u.discordWebhookUrl AS userDiscordWebhookUrl
       FROM run_queue q
       LEFT JOIN app_user u ON u.id = q.userId
      WHERE q.status IN ('completed','failed','cancelled')
      ORDER BY datetime(q.finishedAt) DESC
      LIMIT 10`,
  );

  const history = historyRows.map(mapQueueRowWithUser);
  const averageDuration = await computeAverageDuration(connection);

  return {
    jobs,
    history,
    averageDurationMs: averageDuration,
    queueLength: jobs.length,
  };
}

async function takeNextPendingJob() {
  const connection = await db.getConnection();
  const row = await connection.get(
    `SELECT q.*, u.username AS userUsername, u.fullName AS userFullName, u.role AS userRole,
            u.status AS userStatus, u.discordWebhookUrl AS userDiscordWebhookUrl,
            u.credits AS userCredits, u.rep4repKey AS userRep4repKey
       FROM run_queue q
       JOIN app_user u ON u.id = q.userId
      WHERE q.status = 'pending'
      ORDER BY datetime(q.enqueuedAt)
      LIMIT 1`,
  );

  if (!row) {
    return null;
  }

  const now = new Date().toISOString();
  const update = await connection.run(
    `UPDATE run_queue SET status = 'running', startedAt = ? WHERE id = ? AND status = 'pending'`,
    [now, row.id],
  );

  if (!update || update.changes === 0) {
    return null;
  }

  const job = mapQueueRowWithUser(row, { includeSensitive: true });
  job.status = 'running';
  job.startedAt = now;
  return job;
}

async function completeJob(id, { summary = null, cleanup = null, creditsConsumed = 0, totalComments = 0 } = {}) {
  if (!id) {
    return null;
  }
  const connection = await db.getConnection();
  const finishedAt = new Date().toISOString();
  const current = await connection.get(`SELECT startedAt FROM run_queue WHERE id = ?`, [id]);
  let durationMs = null;
  if (current?.startedAt) {
    const start = new Date(current.startedAt).getTime();
    if (!Number.isNaN(start)) {
      durationMs = Math.max(0, Date.now() - start);
    }
  }

  await connection.run(
    `UPDATE run_queue
        SET status = 'completed',
            finishedAt = ?,
            durationMs = ?,
            summary = ?,
            cleanup = ?,
            creditsConsumed = ?,
            totalComments = ?,
            error = NULL
      WHERE id = ?`,
    [
      finishedAt,
      durationMs,
      summary ? JSON.stringify(summary) : null,
      cleanup ? JSON.stringify(cleanup) : null,
      Number.isFinite(creditsConsumed) ? Math.max(0, Math.round(creditsConsumed)) : 0,
      Number.isFinite(totalComments) ? Math.max(0, Math.round(totalComments)) : 0,
      id,
    ],
  );

  return connection.get(
    `SELECT q.*, u.username AS userUsername, u.fullName AS userFullName,
            u.discordWebhookUrl AS userDiscordWebhookUrl
       FROM run_queue q
       LEFT JOIN app_user u ON u.id = q.userId
      WHERE q.id = ?`,
    [id],
  ).then((row) => mapQueueRowWithUser(row));
}

async function failJob(id, errorMessage) {
  if (!id) {
    return null;
  }
  const connection = await db.getConnection();
  const finishedAt = new Date().toISOString();
  const current = await connection.get(`SELECT startedAt FROM run_queue WHERE id = ?`, [id]);
  let durationMs = null;
  if (current?.startedAt) {
    const start = new Date(current.startedAt).getTime();
    if (!Number.isNaN(start)) {
      durationMs = Math.max(0, Date.now() - start);
    }
  }

  await connection.run(
    `UPDATE run_queue
        SET status = 'failed',
            finishedAt = ?,
            durationMs = ?,
            error = ?
      WHERE id = ?`,
    [finishedAt, durationMs, errorMessage || 'Falha desconhecida.', id],
  );

  return connection.get(
    `SELECT q.*, u.username AS userUsername, u.fullName AS userFullName,
            u.discordWebhookUrl AS userDiscordWebhookUrl
       FROM run_queue q
       LEFT JOIN app_user u ON u.id = q.userId
      WHERE q.id = ?`,
    [id],
  ).then((row) => mapQueueRowWithUser(row));
}

async function cancelJob(id, { reason = 'Cancelado manualmente' } = {}) {
  if (!id) {
    throw new Error('ID do pedido obrigatório para cancelar.');
  }

  const connection = await db.getConnection();
  const row = await connection.get(
    `SELECT q.*, u.username AS userUsername, u.fullName AS userFullName, u.role AS userRole,
            u.status AS userStatus, u.discordWebhookUrl AS userDiscordWebhookUrl,
            u.credits AS userCredits
       FROM run_queue q
       LEFT JOIN app_user u ON u.id = q.userId
      WHERE q.id = ?`,
    [id],
  );

  if (!row) {
    throw new Error('Pedido não encontrado.');
  }

  if (row.status === 'running') {
    throw new Error('Não é possível cancelar pedidos em execução.');
  }

  if (row.status !== 'pending') {
    return { cancelled: false, job: mapQueueRowWithUser(row) };
  }

  const finishedAt = new Date().toISOString();
  await connection.run(
    `UPDATE run_queue
        SET status = 'cancelled',
            finishedAt = ?,
            durationMs = 0,
            error = ?
      WHERE id = ?`,
    [finishedAt, reason || 'Cancelado manualmente', id],
  );

  const updated = await connection.get(
    `SELECT q.*, u.username AS userUsername, u.fullName AS userFullName, u.role AS userRole,
            u.status AS userStatus, u.discordWebhookUrl AS userDiscordWebhookUrl,
            u.credits AS userCredits
       FROM run_queue q
       LEFT JOIN app_user u ON u.id = q.userId
      WHERE q.id = ?`,
    [id],
  );

  return { cancelled: true, job: mapQueueRowWithUser(updated) };
}

async function clearCompleted({ maxEntries = 100 } = {}) {
  const connection = await db.getConnection();
  await connection.run(
    `DELETE FROM run_queue
      WHERE status IN ('completed','failed','cancelled')
        AND id NOT IN (
          SELECT id FROM run_queue
           WHERE status IN ('completed','failed','cancelled')
           ORDER BY datetime(finishedAt) DESC
           LIMIT ?
        )`,
    [Math.max(10, Math.floor(maxEntries))],
  );
}

module.exports = {
  enqueueJob,
  getUserQueueStatus,
  getQueueSnapshot,
  takeNextPendingJob,
  completeJob,
  failJob,
  cancelJob,
  clearCompleted,
};
