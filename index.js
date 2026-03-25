const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");

const token = process.env.BOT_TOKEN;
const databaseUrl = process.env.DATABASE_URL;
const BOT_USERNAME = process.env.BOT_USERNAME || "zaraenik_bot";
const PORT = process.env.PORT || 3000;

if (!token) throw new Error("BOT_TOKEN не найден");
if (!databaseUrl) throw new Error("DATABASE_URL не найден");

const bot = new TelegramBot(token, { polling: true });

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.get("/", (_, res) => res.send("Bot is running"));
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

/* =========================
   UTILS
========================= */

function getDisplayName(user) {
  if (!user) return "Игрок";
  if (user.username) return `@${user.username}`;
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return full || `id${user.id}`;
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function roleNameRu(role) {
  switch (role) {
    case "infected":
      return "Заражённый";
    case "doctor":
      return "Аптекарь";
    case "scanner":
      return "Сканер";
    case "guard":
      return "Охранник";
    default:
      return "Мирный";
  }
}

function roleDescription(role) {
  switch (role) {
    case "infected":
      return "🦠 Твоя роль: Заражённый\n\nНочью ты выбираешь, кого заразить.";
    case "doctor":
      return "💊 Твоя роль: Аптекарь\n\nНочью ты выбираешь, кого лечить.";
    case "scanner":
      return "🔎 Твоя роль: Сканер\n\nНочью ты проверяешь одного игрока.";
    case "guard":
      return "🛡 Твоя роль: Охранник\n\nНочью ты защищаешь одного игрока.";
    default:
      return "🙂 Твоя роль: Мирный\n\nДнём голосуй и ищи заражённых.";
  }
}

function getRolesForCount(count) {
  if (count < 4) return null;
  if (count === 4) return ["infected", "doctor", "scanner", "civilian"];
  if (count === 5) return ["infected", "doctor", "scanner", "civilian", "civilian"];
  if (count === 6) return ["infected", "doctor", "scanner", "guard", "civilian", "civilian"];
  if (count === 7) return ["infected", "infected", "doctor", "scanner", "guard", "civilian", "civilian"];
  return ["infected", "infected", "doctor", "scanner", "guard", "civilian", "civilian", "civilian"];
}

/* =========================
   DB INIT
========================= */

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_lobbies (
      chat_id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL,
      creator_name TEXT NOT NULL,
      started BOOLEAN NOT NULL DEFAULT FALSE,
      phase TEXT NOT NULL DEFAULT 'lobby',
      round_num INTEGER NOT NULL DEFAULT 1,
      lobby_message_id BIGINT,
      vote_message_id BIGINT,
      vote_counts_message_id BIGINT,
      night_actions JSONB NOT NULL DEFAULT '{}'::jsonb,
      votes JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_players (
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      alive BOOLEAN NOT NULL DEFAULT TRUE,
      role TEXT,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chat_id, user_id),
      FOREIGN KEY (chat_id) REFERENCES game_lobbies(chat_id) ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      coins INTEGER NOT NULL DEFAULT 0,
      games INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      survived INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

/* =========================
   PROFILES
========================= */

async function ensureProfile(userId, name) {
  await pool.query(
    `
    INSERT INTO user_profiles (user_id, name)
    VALUES ($1, $2)
    ON CONFLICT (user_id)
    DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
    `,
    [String(userId), name]
  );
}

async function getProfile(userId, name = "Игрок") {
  await ensureProfile(userId, name);
  const res = await pool.query(
    `SELECT * FROM user_profiles WHERE user_id = $1 LIMIT 1`,
    [String(userId)]
  );
  return res.rows[0];
}

/* =========================
   LOBBY LOAD/SAVE
========================= */

async function getLobby(chatId) {
  const lobbyRes = await pool.query(
    `SELECT * FROM game_lobbies WHERE chat_id = $1 LIMIT 1`,
    [String(chatId)]
  );
  if (lobbyRes.rows.length === 0) return null;

  const row = lobbyRes.rows[0];
  const playersRes = await pool.query(
    `SELECT * FROM game_players WHERE chat_id = $1 ORDER BY joined_at ASC`,
    [String(chatId)]
  );

  return {
    chatId: row.chat_id,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    started: row.started,
    phase: row.phase,
    round: row.round_num,
    lobbyMessageId: row.lobby_message_id ? Number(row.lobby_message_id) : null,
    voteMessageId: row.vote_message_id ? Number(row.vote_message_id) : null,
    voteCountsMessageId: row.vote_counts_message_id ? Number(row.vote_counts_message_id) : null,
    nightActions: row.night_actions || {
      infectedByActor: {},
      doctor: null,
      scanner: null,
      guard: null
    },
    votes: row.votes || {},
    players: playersRes.rows.map((p) => ({
      id: p.user_id,
      name: p.name,
      alive: p.alive,
      role: p.role
    }))
  };
}

async function saveLobby(lobby) {
  await pool.query(
    `
    UPDATE game_lobbies
    SET
      started = $2,
      phase = $3,
      round_num = $4,
      lobby_message_id = $5,
      vote_message_id = $6,
      vote_counts_message_id = $7,
      night_actions = $8::jsonb,
      votes = $9::jsonb,
      updated_at = NOW()
    WHERE chat_id = $1
    `,
    [
      String(lobby.chatId),
      lobby.started,
      lobby.phase,
      lobby.round,
      lobby.lobbyMessageId,
      lobby.voteMessageId,
      lobby.voteCountsMessageId,
      JSON.stringify(lobby.nightActions || {}),
      JSON.stringify(lobby.votes || {})
    ]
  );
}

async function savePlayer(chatId, player) {
  await pool.query(
    `
    UPDATE game_players
    SET name = $3, alive = $4, role = $5
    WHERE chat_id = $1 AND user_id = $2
    `,
    [String(chatId), String(player.id), player.name, player.alive, player.role]
  );
}

async function createLobby(chatId, creator) {
  const creatorName = getDisplayName(creator);
  await ensureProfile(creator.id, creatorName);

  await pool.query(
    `
    INSERT INTO game_lobbies (
      chat_id, creator_id, creator_name, started, phase, round_num,
      lobby_message_id, vote_message_id, vote_counts_message_id,
      night_actions, votes
    )
    VALUES (
      $1, $2, $3, FALSE, 'lobby', 1,
      NULL, NULL, NULL,
      '{"infectedByActor":{},"doctor":null,"scanner":null,"guard":null}'::jsonb,
      '{}'::jsonb
    )
    `,
    [String(chatId), String(creator.id), creatorName]
  );

  await pool.query(
    `
    INSERT INTO game_players (chat_id, user_id, name, alive, role)
    VALUES ($1, $2, $3, TRUE, NULL)
    `,
    [String(chatId), String(creator.id), creatorName]
  );

  return getLobby(chatId);
}

async function deleteLobby(chatId) {
  await pool.query(`DELETE FROM game_lobbies WHERE chat_id = $1`, [String(chatId)]);
}

/* =========================
   GAME HELPERS
========================= */

function getPlayer(lobby, userId) {
  return lobby.players.find((p) => String(p.id) === String(userId));
}

function getAlivePlayers(lobby) {
  return lobby.players.filter((p) => p.alive);
}

function getAliveInfected(lobby) {
  return lobby.players.filter((p) => p.alive && p.role === "infected");
}

function getAliveNonInfected(lobby) {
  return lobby.players.filter((p) => p.alive && p.role !== "infected");
}

function isCreator(lobby, userId) {
  return String(lobby.creatorId) === String(userId);
}

function getJoinLink(chatId) {
  return `https://t.me/${BOT_USERNAME}?start=join_${chatId}`;
}

function buildLobbyText(lobby) {
  const playersText = lobby.players.map((p, i) => `${i + 1}. ${p.name}`).join("\n");

  return (
    `🧪 *Лобби "Заражение"*\n\n` +
    `Создатель: ${lobby.creatorName}\n\n` +
    `*Игроки:*\n${playersText}\n\n` +
    `Ссылка для входа:\n${getJoinLink(lobby.chatId)}\n\n` +
    `Нажми кнопку *Играть* ниже или перейди по ссылке.\n` +
    `После нажатия *Start* бот автоматически добавит тебя в список игроков.\n\n` +
    `Для старта нужно минимум 4 игрока.\n` +
    `Старт игры: /startgame`
  );
}

function buildLobbyKeyboard(lobby) {
  return {
    inline_keyboard: [[{ text: "🎮 Играть", url: getJoinLink(lobby.chatId) }]]
  };
}

async function renderLobbyMessage(lobby) {
  if (!lobby.lobbyMessageId) return;
  try {
    await bot.editMessageText(buildLobbyText(lobby), {
      chat_id: lobby.chatId,
      message_id: lobby.lobbyMessageId,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: buildLobbyKeyboard(lobby)
    });
  } catch (e) {
    console.log("edit lobby:", e.message);
  }
}

async function sendRole(player) {
  try {
    await bot.sendMessage(player.id, roleDescription(player.role));
  } catch (e) {
    console.log("send role:", e.message);
  }
}

function buildFinalRolesText(lobby) {
  return lobby.players
    .map((p, i) => `${i + 1}. ${p.name} — ${roleNameRu(p.role)} (${p.alive ? "жив" : "выбыл"})`)
    .join("\n");
}

function checkWinner(lobby) {
  const infected = getAliveInfected(lobby).length;
  const nonInfected = getAliveNonInfected(lobby).length;

  if (infected === 0) return "civilian";
  if (infected >= nonInfected) return "infected";
  return null;
}

async function rewardPlayers(lobby, winner) {
  const lines = [];

  for (const player of lobby.players) {
    let reward = 0;

    const isWinner =
      (winner === "infected" && player.role === "infected") ||
      (winner === "civilian" && player.role !== "infected");

    if (player.alive) reward += 10;
    if (isWinner) reward += 10;

    await pool.query(
      `
      INSERT INTO user_profiles (user_id, name, coins, games, wins, survived)
      VALUES ($1, $2, $3, 1, $4, $5)
      ON CONFLICT (user_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        coins = user_profiles.coins + $3,
        games = user_profiles.games + 1,
        wins = user_profiles.wins + $4,
        survived = user_profiles.survived + $5,
        updated_at = NOW()
      `,
      [
        String(player.id),
        player.name,
        reward,
        isWinner ? 1 : 0,
        player.alive ? 1 : 0
      ]
    );

    lines.push(`${player.name} — +${reward} монет`);
  }

  return lines.join("\n");
}

async function finishGame(lobby, winner) {
  lobby.phase = "ended";
  await saveLobby(lobby);

  const rewardsText = await rewardPlayers(lobby, winner);
  const winText =
    winner === "infected"
      ? `🦠 *Победа заражённых!*`
      : `🙂 *Победа мирных!*`;

  await bot.sendMessage(
    lobby.chatId,
    `${winText}\n\n*Игроки и роли:*\n${buildFinalRolesText(lobby)}\n\n*Награды:*\n${rewardsText}`,
    { parse_mode: "Markdown" }
  );

  await deleteLobby(lobby.chatId);
}

/* =========================
   NIGHT
========================= */

function createNightKeyboard(lobby, actorId, action) {
  const alivePlayers = getAlivePlayers(lobby).filter((p) => String(p.id) !== String(actorId));
  return {
    inline_keyboard: alivePlayers.map((p) => [
      { text: p.name, callback_data: `night:${action}:${lobby.chatId}:${p.id}` }
    ])
  };
}

function allNightActionsDone(lobby) {
  const alive = getAlivePlayers(lobby);
  const infectedAlive = alive.filter((p) => p.role === "infected").length;
  const doctorAlive = alive.some((p) => p.role === "doctor");
  const scannerAlive = alive.some((p) => p.role === "scanner");
  const guardAlive = alive.some((p) => p.role === "guard");

  const infectedDone = Object.keys(lobby.nightActions.infectedByActor || {}).length >= infectedAlive;
  const doctorDone = !doctorAlive || lobby.nightActions.doctor !== null;
  const scannerDone = !scannerAlive || lobby.nightActions.scanner !== null;
  const guardDone = !guardAlive || lobby.nightActions.guard !== null;

  return infectedDone && doctorDone && scannerDone && guardDone;
}

async function maybeFinishNight(lobby) {
  if (!allNightActionsDone(lobby)) return;
  await finishNight(lobby);
}

async function startNight(lobby) {
  lobby.phase = "night";
  lobby.nightActions = {
    infectedByActor: {},
    doctor: null,
    scanner: null,
    guard: null
  };
  lobby.votes = {};
  lobby.voteMessageId = null;
  lobby.voteCountsMessageId = null;
  await saveLobby(lobby);

  await bot.sendMessage(
    lobby.chatId,
    `🌙 *Ночь ${lobby.round}*\n\nНочные роли, проверьте личные сообщения.`,
    { parse_mode: "Markdown" }
  );

  for (const player of getAlivePlayers(lobby)) {
    try {
      if (player.role === "infected") {
        await bot.sendMessage(player.id, `🌙 Ночь ${lobby.round}\nВыбери, кого заразить:`, {
          reply_markup: createNightKeyboard(lobby, player.id, "infect")
        });
      } else if (player.role === "doctor") {
        await bot.sendMessage(player.id, `🌙 Ночь ${lobby.round}\nВыбери, кого лечить:`, {
          reply_markup: createNightKeyboard(lobby, player.id, "heal")
        });
      } else if (player.role === "scanner") {
        await bot.sendMessage(player.id, `🌙 Ночь ${lobby.round}\nВыбери, кого проверить:`, {
          reply_markup: createNightKeyboard(lobby, player.id, "scan")
        });
      } else if (player.role === "guard") {
        await bot.sendMessage(player.id, `🌙 Ночь ${lobby.round}\nВыбери, кого защитить:`, {
          reply_markup: createNightKeyboard(lobby, player.id, "guard")
        });
      }
    } catch (e) {
      console.log("night msg:", e.message);
    }
  }

  await maybeFinishNight(lobby);
}

async function finishNight(lobby) {
  if (lobby.phase !== "night") return;

  const infectedChoices = Object.values(lobby.nightActions.infectedByActor || {});
  const doctorTarget = lobby.nightActions.doctor;
  const scannerTarget = lobby.nightActions.scanner;
  const guardTarget = lobby.nightActions.guard;

  let finalTarget = null;

  if (infectedChoices.length > 0) {
    const counts = {};
    for (const t of infectedChoices) counts[t] = (counts[t] || 0) + 1;

    let maxVotes = 0;
    let hasTie = false;
    for (const [targetId, votes] of Object.entries(counts)) {
      if (votes > maxVotes) {
        maxVotes = votes;
        finalTarget = String(targetId);
        hasTie = false;
      } else if (votes === maxVotes) {
        hasTie = true;
      }
    }
    if (hasTie) finalTarget = null;
  }

  if (scannerTarget !== null) {
    const scanner = getAlivePlayers(lobby).find((p) => p.role === "scanner");
    const checked = getPlayer(lobby, scannerTarget);
    if (scanner && checked) {
      try {
        await bot.sendMessage(
          scanner.id,
          checked.role === "infected"
            ? `🔎 Проверка: ${checked.name} — заражённый.`
            : `🔎 Проверка: ${checked.name} — не заражённый.`
        );
      } catch (e) {
        console.log("scanner result:", e.message);
      }
    }
  }

  let text = `☀ *День ${lobby.round}*\n\n`;

  if (!finalTarget) {
    text += `Ночью ничего не произошло.`;
  } else if (finalTarget === doctorTarget || finalTarget === guardTarget) {
    const saved = getPlayer(lobby, finalTarget);
    text += saved
      ? `Ночью попытка заражения была остановлена.\n${saved.name} удалось спасти.`
      : `Ночью попытка заражения была остановлена.`;
  } else {
    const victim = getPlayer(lobby, finalTarget);
    if (victim && victim.alive && victim.role !== "infected") {
      victim.role = "infected";
      await savePlayer(lobby.chatId, victim);
      text += `Ночью был заражён игрок: ${victim.name}`;

      try {
        await bot.sendMessage(
          victim.id,
          `🦠 Ты был заражён.\nТеперь твоя роль — Заражённый.\nСледующей ночью ты сможешь делать ход.`
        );
      } catch (e) {
        console.log("infected notify:", e.message);
      }
    } else {
      text += `Ночью ничего не произошло.`;
    }
  }

  await bot.sendMessage(lobby.chatId, text, { parse_mode: "Markdown" });

  const winner = checkWinner(lobby);
  if (winner) {
    await finishGame(lobby, winner);
    return;
  }

  await startVoting(lobby);
}

/* =========================
   VOTING IN GROUP
========================= */

function buildVotingKeyboard(lobby) {
  const alivePlayers = getAlivePlayers(lobby);
  return {
    inline_keyboard: [
      ...alivePlayers.map((p) => [
        { text: p.name, callback_data: `vote:${lobby.chatId}:${p.id}` }
      ]),
      [{ text: "⏭ Пропуск", callback_data: `vote:${lobby.chatId}:skip` }]
    ]
  };
}

function allAliveVoted(lobby) {
  return getAlivePlayers(lobby).every((p) => lobby.votes[String(p.id)] !== undefined);
}

function getVoteCountText(lobby) {
  const alivePlayers = getAlivePlayers(lobby);
  const lines = [];

  for (const player of alivePlayers) {
    let count = 0;
    for (const vote of Object.values(lobby.votes)) {
      if (String(vote) === String(player.id)) count += 1;
    }
    lines.push(`${player.name} — ${count}`);
  }

  let skipCount = 0;
  for (const vote of Object.values(lobby.votes)) {
    if (vote === "skip") skipCount += 1;
  }
  lines.push(`Пропуск — ${skipCount}`);

  return `📊 *Голоса сейчас:*\n${lines.join("\n")}`;
}

async function updateVoteCountMessage(lobby) {
  if (!lobby.voteCountsMessageId) return;
  try {
    await bot.editMessageText(getVoteCountText(lobby), {
      chat_id: lobby.chatId,
      message_id: lobby.voteCountsMessageId,
      parse_mode: "Markdown"
    });
  } catch (e) {
    console.log("edit votes:", e.message);
  }
}

async function startVoting(lobby) {
  lobby.phase = "voting";
  lobby.votes = {};
  await saveLobby(lobby);

  const voteMsg = await bot.sendMessage(
    lobby.chatId,
    `📦 *Голосование*\n\nВыберите, кого изгнать.`,
    {
      parse_mode: "Markdown",
      reply_markup: buildVotingKeyboard(lobby)
    }
  );
  lobby.voteMessageId = voteMsg.message_id;

  const countsMsg = await bot.sendMessage(
    lobby.chatId,
    getVoteCountText(lobby),
    { parse_mode: "Markdown" }
  );
  lobby.voteCountsMessageId = countsMsg.message_id;

  await saveLobby(lobby);
}

async function finishVoting(lobby) {
  if (lobby.phase !== "voting") return;

  lobby.phase = "voting_finished";
  await saveLobby(lobby);

  const counts = {};
  for (const target of Object.values(lobby.votes)) {
    counts[target] = (counts[target] || 0) + 1;
  }

  let maxVotes = 0;
  let selected = null;
  let hasTie = false;

  for (const [target, votes] of Object.entries(counts)) {
    if (votes > maxVotes) {
      maxVotes = votes;
      selected = target;
      hasTie = false;
    } else if (votes === maxVotes) {
      hasTie = true;
    }
  }

  let text = `🗳 *Голосование окончено*\n\n`;

  if (!selected || hasTie || selected === "skip") {
    text += `Никто не был изгнан.`;
  } else {
    const player = getPlayer(lobby, selected);
    if (player && player.alive) {
      player.alive = false;
      await savePlayer(lobby.chatId, player);
      text += `Изгнан игрок: ${player.name}\nРоль игрока: *${roleNameRu(player.role)}*`;
    } else {
      text += `Никто не был изгнан.`;
    }
  }

  await bot.sendMessage(lobby.chatId, text, { parse_mode: "Markdown" });

  const winner = checkWinner(lobby);
  if (winner) {
    await finishGame(lobby, winner);
    return;
  }

  lobby.round += 1;
  await saveLobby(lobby);
  await startNight(lobby);
}

/* =========================
   JOIN
========================= */

async function addUserToLobby(user, chatId) {
  const lobby = await getLobby(chatId);

  if (!lobby) return { ok: false, text: "Лобби не найдено или игра уже закончилась." };
  if (lobby.started) return { ok: false, text: "Игра уже началась. Войти нельзя." };
  if (lobby.players.length >= 8) return { ok: false, text: "Лобби уже заполнено." };

  const already = getPlayer(lobby, user.id);
  if (already) return { ok: true, text: "Ты уже есть в этом лобби." };

  const name = getDisplayName(user);
  await ensureProfile(user.id, name);

  await pool.query(
    `
    INSERT INTO game_players (chat_id, user_id, name, alive, role)
    VALUES ($1, $2, $3, TRUE, NULL)
    `,
    [String(chatId), String(user.id), name]
  );

  const freshLobby = await getLobby(chatId);
  await renderLobbyMessage(freshLobby);

  return { ok: true, text: `✅ Ты добавлен в игру.\nТвой ник: ${name}` };
}

/* =========================
   COMMANDS
========================= */

bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  try {
    if (msg.chat.type !== "private") {
      await bot.sendMessage(msg.chat.id, "Напиши мне в личку.");
      return;
    }

    const name = getDisplayName(msg.from);
    await ensureProfile(msg.from.id, name);

    const payload = match && match[1] ? match[1].trim() : "";
    if (payload.startsWith("join_")) {
      const chatId = payload.replace("join_", "");
      const result = await addUserToLobby(msg.from, chatId);
      await bot.sendMessage(msg.chat.id, result.text);
      return;
    }

    await bot.sendMessage(
      msg.chat.id,
      `Привет, ${name}!\n\nНажми кнопку *Играть* в группе или открой ссылку из лобби.`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.log("/start:", e.message);
  }
});

bot.onText(/^\/create_game$/, async (msg) => {
  try {
    if (msg.chat.type === "private") {
      await bot.sendMessage(msg.chat.id, "Эту команду нужно писать в группе.");
      return;
    }

    const existing = await getLobby(msg.chat.id);
    if (existing) {
      await bot.sendMessage(msg.chat.id, "В этой группе уже есть активная игра.");
      return;
    }

    const lobby = await createLobby(msg.chat.id, msg.from);

    const sent = await bot.sendMessage(msg.chat.id, buildLobbyText(lobby), {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: buildLobbyKeyboard(lobby)
    });

    lobby.lobbyMessageId = sent.message_id;
    await saveLobby(lobby);
  } catch (e) {
    console.log("/create_game:", e.message);
    await bot.sendMessage(msg.chat.id, "Ошибка создания игры.");
  }
});

bot.onText(/^\/startgame$/, async (msg) => {
  try {
    if (msg.chat.type === "private") {
      await bot.sendMessage(msg.chat.id, "Эту команду нужно писать в группе.");
      return;
    }

    const lobby = await getLobby(msg.chat.id);

    if (!lobby) {
      await bot.sendMessage(msg.chat.id, "Сначала создай игру через /create_game");
      return;
    }

    if (!isCreator(lobby, msg.from.id)) {
      await bot.sendMessage(msg.chat.id, "Начать игру может только создатель.");
      return;
    }

    if (lobby.started) {
      await bot.sendMessage(msg.chat.id, "Игра уже началась.");
      return;
    }

    const roles = getRolesForCount(lobby.players.length);
    if (!roles) {
      await bot.sendMessage(msg.chat.id, "Для старта нужно минимум 4 игрока.");
      return;
    }

    lobby.started = true;

    const shuffledPlayers = shuffle(lobby.players);
    const shuffledRoles = shuffle(roles);

    for (let i = 0; i < shuffledPlayers.length; i++) {
      shuffledPlayers[i].role = shuffledRoles[i] || "civilian";
      await savePlayer(lobby.chatId, shuffledPlayers[i]);
    }

    await saveLobby(lobby);

    await bot.sendMessage(
      msg.chat.id,
      `🎮 *Игра началась!*\n\nИгроков: ${lobby.players.length}\nРоли отправлены в личные сообщения.`,
      { parse_mode: "Markdown" }
    );

    for (const player of shuffledPlayers) {
      await sendRole(player);
    }

    const freshLobby = await getLobby(msg.chat.id);
    await startNight(freshLobby);
  } catch (e) {
    console.log("/startgame:", e.message);
    await bot.sendMessage(msg.chat.id, "Ошибка запуска игры.");
  }
});

bot.onText(/^\/cancel_game$/, async (msg) => {
  try {
    const lobby = await getLobby(msg.chat.id);

    if (!lobby) {
      await bot.sendMessage(msg.chat.id, "Активной игры нет.");
      return;
    }

    if (!isCreator(lobby, msg.from.id)) {
      await bot.sendMessage(msg.chat.id, "Отменить игру может только создатель.");
      return;
    }

    await deleteLobby(msg.chat.id);
    await bot.sendMessage(msg.chat.id, "Игра отменена.");
  } catch (e) {
    console.log("/cancel_game:", e.message);
    await bot.sendMessage(msg.chat.id, "Ошибка отмены игры.");
  }
});

bot.onText(/^\/finishvote$/, async (msg) => {
  try {
    const lobby = await getLobby(msg.chat.id);

    if (!lobby) {
      await bot.sendMessage(msg.chat.id, "Активной игры нет.");
      return;
    }

    if (!isCreator(lobby, msg.from.id)) {
      await bot.sendMessage(msg.chat.id, "Завершить голосование может только создатель.");
      return;
    }

    if (lobby.phase !== "voting") {
      await bot.sendMessage(msg.chat.id, "Сейчас нет активного голосования.");
      return;
    }

    await finishVoting(lobby);
  } catch (e) {
    console.log("/finishvote:", e.message);
    await bot.sendMessage(msg.chat.id, "Ошибка завершения голосования.");
  }
});

bot.onText(/^\/profile$/, async (msg) => {
  try {
    const name = getDisplayName(msg.from);
    const profile = await getProfile(msg.from.id, name);

    await bot.sendMessage(
      msg.chat.id,
      `👤 *Профиль*\n\n` +
        `Имя: ${profile.name}\n` +
        `Монеты: ${profile.coins}\n` +
        `Игр: ${profile.games}\n` +
        `Побед: ${profile.wins}\n` +
        `Выжил: ${profile.survived}`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.log("/profile:", e.message);
  }
});

bot.onText(/^\/top$/, async (msg) => {
  try {
    const res = await pool.query(
      `SELECT name, coins FROM user_profiles ORDER BY coins DESC, name ASC LIMIT 10`
    );

    if (res.rows.length === 0) {
      await bot.sendMessage(msg.chat.id, "Топ пока пуст.");
      return;
    }

    const text = res.rows
      .map((p, i) => `${i + 1}. ${p.name} — ${p.coins} монет`)
      .join("\n");

    await bot.sendMessage(
      msg.chat.id,
      `🏆 *Топ игроков*\n\n${text}`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.log("/top:", e.message);
  }
});

/* =========================
   CALLBACKS
========================= */

bot.on("callback_query", async (query) => {
  try {
    const data = query.data || "";
    const fromId = String(query.from.id);

    if (data.startsWith("night:")) {
      const [, action, chatId, targetId] = data.split(":");
      const lobby = await getLobby(chatId);

      if (!lobby) {
        await bot.answerCallbackQuery(query.id, { text: "Игра не найдена." });
        return;
      }

      if (lobby.phase !== "night") {
        await bot.answerCallbackQuery(query.id, { text: "Ночь уже закончилась." });
        return;
      }

      const actor = getPlayer(lobby, fromId);
      const target = getPlayer(lobby, targetId);

      if (!actor || !actor.alive) {
        await bot.answerCallbackQuery(query.id, { text: "Ты не участвуешь в игре." });
        return;
      }

      if (!target || !target.alive) {
        await bot.answerCallbackQuery(query.id, { text: "Игрок недоступен." });
        return;
      }

      if (action === "infect") {
        if (actor.role !== "infected") {
          await bot.answerCallbackQuery(query.id, { text: "Это не твоя роль." });
          return;
        }
        if (lobby.nightActions.infectedByActor[fromId]) {
          await bot.answerCallbackQuery(query.id, { text: "Ты уже сделал ход." });
          return;
        }
        lobby.nightActions.infectedByActor[fromId] = String(targetId);
        await saveLobby(lobby);
        await bot.answerCallbackQuery(query.id, { text: `Ты выбрал ${target.name}` });
      }

      if (action === "heal") {
        if (actor.role !== "doctor") {
          await bot.answerCallbackQuery(query.id, { text: "Это не твоя роль." });
          return;
        }
        if (lobby.nightActions.doctor !== null) {
          await bot.answerCallbackQuery(query.id, { text: "Ты уже сделал ход." });
          return;
        }
        lobby.nightActions.doctor = String(targetId);
        await saveLobby(lobby);
        await bot.answerCallbackQuery(query.id, { text: `Ты лечишь ${target.name}` });
      }

      if (action === "scan") {
        if (actor.role !== "scanner") {
          await bot.answerCallbackQuery(query.id, { text: "Это не твоя роль." });
          return;
        }
        if (lobby.nightActions.scanner !== null) {
          await bot.answerCallbackQuery(query.id, { text: "Ты уже сделал ход." });
          return;
        }
        lobby.nightActions.scanner = String(targetId);
        await saveLobby(lobby);
        await bot.answerCallbackQuery(query.id, { text: `Ты проверяешь ${target.name}` });
      }

      if (action === "guard") {
        if (actor.role !== "guard") {
          await bot.answerCallbackQuery(query.id, { text: "Это не твоя роль." });
          return;
        }
        if (lobby.nightActions.guard !== null) {
          await bot.answerCallbackQuery(query.id, { text: "Ты уже сделал ход." });
          return;
        }
        lobby.nightActions.guard = String(targetId);
        await saveLobby(lobby);
        await bot.answerCallbackQuery(query.id, { text: `Ты защищаешь ${target.name}` });
      }

      const freshLobby = await getLobby(chatId);
      await maybeFinishNight(freshLobby);
      return;
    }

    if (data.startsWith("vote:")) {
      const [, chatId, targetId] = data.split(":");
      const lobby = await getLobby(chatId);

      if (!lobby) {
        await bot.answerCallbackQuery(query.id, { text: "Игра не найдена." });
        return;
      }

      if (lobby.phase !== "voting") {
        await bot.answerCallbackQuery(query.id, { text: "Голосование уже окончено." });
        return;
      }

      const voter = getPlayer(lobby, fromId);

      if (!voter || !voter.alive) {
        await bot.answerCallbackQuery(query.id, { text: "Ты не можешь голосовать." });
        return;
      }

      if (lobby.votes[fromId] !== undefined) {
        await bot.answerCallbackQuery(query.id, { text: "Ты уже проголосовал." });
        return;
      }

      if (targetId === "skip") {
        lobby.votes[fromId] = "skip";
        await saveLobby(lobby);
        await bot.answerCallbackQuery(query.id, { text: "Ты выбрал пропуск." });

        await bot.sendMessage(
          lobby.chatId,
          `🗳 ${voter.name} проголосовал: *Пропуск*`,
          { parse_mode: "Markdown" }
        );
      } else {
        const target = getPlayer(lobby, targetId);
        if (!target || !target.alive) {
          await bot.answerCallbackQuery(query.id, { text: "Этот игрок уже недоступен." });
          return;
        }

        lobby.votes[fromId] = String(targetId);
        await saveLobby(lobby);
        await bot.answerCallbackQuery(query.id, { text: `Ты голосуешь против ${target.name}` });

        await bot.sendMessage(
          lobby.chatId,
          `🗳 ${voter.name} проголосовал против ${target.name}`
        );
      }

      const freshLobby = await getLobby(chatId);
      await updateVoteCountMessage(freshLobby);

      if (allAliveVoted(freshLobby)) {
        await finishVoting(freshLobby);
      }
      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (e) {
    console.log("callback:", e);
    try {
      await bot.answerCallbackQuery(query.id, { text: "Ошибка кнопки." });
    } catch {}
  }
});

bot.on("polling_error", (e) => {
  console.log("polling:", e);
});

(async () => {
  try {
    await initDb();
    console.log("DB ready");
  } catch (e) {
    console.error("DB init error:", e);
    process.exit(1);
  }
})();
