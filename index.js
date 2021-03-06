const PORT = process.env.PORT || 3000;
const app = require('express')();
const http = require('http').createServer(app);
var io = require('socket.io')(http);

const { Client } = require('pg');
const { v4: uuidv4 } = require('uuid');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

client.connect();

app.get('/', (req, res) => {
  res.send('');
});

http.listen(PORT, () => {
	console.log("listening...");
});

function report_server_error(err, gid, data) {
  console.log(err.stack);
  io.to(gid).emit("server error", data);
}

function report_sql_error(err, gid) {
  report_server_error(err, gid, {type:"SQL"});
}

function handle_generic_error(err, data, callback) {
  console.log(err.stack);
  data.response = "error";
  data.error = "unknown";
  callback(data);
}

function add_new_user_to_game(socket, uid, username, session_id, game_data, callback) {
  let response_data = {
    response:"success",
    username:username,
    game:game_data.name
  };

  if(!session_id) {
    session_id = uuidv4();
  }

  let player_state = "idle";
  if(game_data.state == "secret" || game_data.state == "guess") {
    player_state = "wait";
  }

  client.query("UPDATE users SET gid = $1, session_id = $3, state = $4 WHERE uid = $2;",
    [game_data.gid, uid, session_id, player_state])
  .catch(err => {handle_generic_error(err, response_data, callback);});

  socket.join(game_data.gid);

  response_data.response = "success";
  response_data.uid = uid;
  response_data.gid = game_data.gid;
  response_data.session_id = session_id;
  response_data.game_data = game_data;

  fix_recencies(game_data.gid, game_data.turn);

  if(game_data.state == "prompt" || game_data.state == "secret") {
    deal_single_player(game_data.gid, uid, game_data.hand_size);
  } else if(game_data.state == "guess") {
    deal_single_player(game_data.gid, uid, game_data.hand_size - 1);
  }

  callback(response_data);
  socket.to(game_data.gid).emit("player update");


  console.log("new user " + username + " joined game "+ game_data.name);
}

async function user_rejoin_game(socket, user_data, game_data, callback) {
  response_data = {
    response:"success",
    username:user_data.username,
    game:game_data.name,
    uid:user_data.uid,
    session_id:user_data.session_id,
    gid:game_data.gid,
    game_data:game_data
  }

  socket.join(game_data.gid);
  callback(response_data);
}


async function join_game(socket, username, game, session_id, callback) {
  var uid;
  var response_data = {
    username:username,
    game:game
  };
  let join_status = await user_can_join(username, game, session_id);
  if(!join_status.allowed) {
    response_data.response = "error";
    response_data.error = join_status.reason;
    callback(response_data);
    return;
  }
  client.query("INSERT INTO users(name, game) VALUES($1, $2) RETURNING uid",
      [username, game])
    .then(async res => {
      uid = res.rows[0].uid;
      return await client.query("INSERT INTO games(name, turn) VALUES($1, $2) \
      ON CONFLICT ON CONSTRAINT name_unique DO UPDATE SET name = EXCLUDED.name RETURNING *;",
      [game, uid]).catch(err => {handle_generic_error(err, response_data, callback);});
    })
    .then(res => {
      add_new_user_to_game(socket, uid, username, session_id, res.rows[0], callback);
    }).catch(async err => {
      if(err.code == 23505 && err.constraint == "user_game") {
        let game_data = await get_game_data(game);
        let user_data = await get_user_data(username, game_data.gid);

        if(user_data.state == "left") {
          console.log("added previously left user " + username + " to game");
          add_new_user_to_game(socket, user_data.uid, username, session_id, game_data, callback);
        } else {
          console.log("user " + username + " rejoined game " + game);
          user_rejoin_game(socket, user_data, game_data, callback);
        }
      } else {
        handle_generic_error(err, response_data, callback);
      }
    });
}

async function user_can_join(user, game, session_id) {
  let game_data = await get_game_data(game);
  let join_status = {
    allowed:true
  };

  //no game initialized: fine to join
  if(!game_data) {
    return join_status;
  }

  if(game_data.game_state == "end") {
    join_status.allowed = false;
    join_status.reason = "game_ended";
    return join_status;
  }

  let res = await client.query("SELECT * FROM users WHERE gid = $1 AND name = $2 AND state != 'left';",
    [game_data.gid, user]);

  if(res.rows.length == 0) {
    return join_status;
  }
  console.log("session id: ");
  console.log(res.rows[0].session_id);
  if(res.rows[0].session_id && res.rows[0].session_id != session_id && res.rows[0].state != "left") {
    console.log("session ids do not match");
    join_status.allowed = false;
    join_status.reason = "user_connected";
    return join_status;
  }

  //user exists already, but we can rejoin
  return join_status;
}

async function leave_game(socket, uid, gid) {
  socket.leave(gid);

  await client.query("UPDATE users SET state = 'left' WHERE uid = $1;", [uid]);
  io.to(gid).emit("player update");

  client.query("UPDATE cards SET state = 'deck', uid = NULL WHERE uid = $1 AND state = 'hand';", [uid]);

  let game_data = await get_gid_data(gid);
  
  if(game_data.state == "prompt") {
    begin_turn(gid);
  } else if(game_data.state == "secret") {
    if(await players_ready(gid)) {
      start_guess_round(game_data.gid, game_data.turn);
    }
  } else if(game_data.state == "guess") {
    if(await players_ready(gid)) {
      io.to(game_data.gid).emit("reveal guess", {});
      advance_turn(gid);
    }
  }

  let res = await client.query("SELECT * FROM users WHERE gid = $1 AND state != 'left';", [gid]);
  if(res.rows.length == 0) {
    delete_game(gid);
  }
}

function update_game_state(gid, state) {
  client.query("UPDATE games SET state = $1 WHERE gid = $2;",
    [state, gid]).catch((err) => report_sql_error(err, gid));
}

function update_score(uid, score) {
  client.query("UPDATE users SET score = $1 WHERE uid = $2;",
    [score, uid]).catch((err) => report_sql_error(err, gid));
}

function delete_all_data() {
  client.query("DELETE FROM games;").catch((err) => report_sql_error(err, gid));
}

async function get_room_id(room) {
  try {
    const res = await client.query("SELECT gid FROM games WHERE name = $1", [room]);
    return res.rows[0].gid;
  } catch(err) {
    console.log(err.stack);
  }
}

async function get_room_name(gid) {
  try {
    const res = await client.query("SELECT name FROM games WHERE gid = $1", [gid]);
    return res.rows[0].name;
  } catch(err) {
    console.log(err.stack);
  }
}

async function get_username(uid) {
  const res = await client.query("SELECT name FROM users WHERE uid = $1;", [uid]);
  return res.rows[0].name;
}

async function get_remaining_cards(gid) {
  const res = await client.query("SELECT * FROM cards WHERE gid = $1 AND state = 'deck';",
    [gid]);
  console.log("remaining cards: " + res.rows.length);
  return res.rows.length;
}

async function get_game_data(name) {
  const res = await client.query("SELECT * FROM games WHERE name = $1;", [name]);
  return res.rows[0];
}

async function get_user_data(username, gid) {
  const res = await client.query("SELECT * FROM users WHERE name = $1 AND gid = $2;", 
    [username, gid]);
  return res.rows[0];
}

async function get_gid_data(gid) {
  const res = await client.query("SELECT * FROM games WHERE gid = $1;", [gid]);
  return res.rows[0];
}

function index_present(hex_code, index) {
  let hex_index = Math.floor(index / 4);
  
  if(hex_index >= hex_code.length) {
    return false;
  }

  let halfbyte = "0x" + hex_code[Math.floor(index / 4)];
  console.log(halfbyte);
  return parseInt(halfbyte) & (1 << (3 - index % 4));
}

async function setup_cards(gid, limit, artists, hex_code) {
  if(hex_code != undefined && hex_code.length > 0) {
    let res = await client.query("INSERT INTO cards(filename, gid, artist) \
      (SELECT filename, gid, artist FROM default_cards INNER JOIN games ON $1 = gid ORDER BY date_added, filename) RETURNING cid;", [gid]);
    let to_delete = new Array();
    for(let i = 0; i < res.rows.length; i++) {
      if(!index_present(hex_code, i)) {
        console.log(res.rows[i]);
        to_delete.push(res.rows[i].cid);
      }
    }
    console.log("cards not found in custom deck:");
    console.log(to_delete);
    await client.query("UPDATE cards SET state = 'ordered' WHERE gid = $1;", [gid]);
    await client.query("DELETE FROM cards WHERE gid = $1 AND cid = ANY($2);",
      [gid, to_delete]);
    await client.query("INSERT INTO cards(filename, gid, artist) SELECT filename, gid, artist FROM cards WHERE gid = $1 ORDER BY random();", [gid]);
    await client.query("DELETE FROM cards WHERE gid = $1 AND state = 'ordered';", [gid]);
    return;
  }
  if(limit == -1) {
    await client.query("INSERT INTO cards(filename, gid, artist) \
      (SELECT filename, gid, artist FROM default_cards INNER JOIN games ON $1 = gid WHERE artist = ANY($2));",
      [gid, artists]).catch(err => handle_generic_error(err));
  } else {
    await client.query("INSERT INTO cards(filename, gid, artist) \
      (SELECT filename, gid, artist FROM default_cards INNER JOIN games ON $1 = gid WHERE artist = ANY($3) ORDER BY random() LIMIT $2);",
      [gid, limit, artists]).catch(err => handle_generic_error(err));
  }
}

function begin_game(gid) {
  client.query("UPDATE games SET state = 'prompt' WHERE gid = $1;",
    [gid]);
  begin_turn(gid);
  get_gid_data(gid).then(data => {
     io.to(gid).emit('start game', data);
     console.log(data);
  });
}

async function deal_cards(gid, to_deal) {
  let res = await client.query("SELECT cid, filename FROM cards WHERE gid = $1 AND state='deck' ORDER BY random();", [gid]);
  cards = res.rows;

  name = await get_room_name(gid);

  res = await client.query("SELECT equal_hands FROM games WHERE gid = $1;", [gid]);
  let equal_hands = res.rows[0].equal_hands;

  res = await client.query("SELECT uid, name FROM users WHERE game = $1 AND state != 'left';", [name]);
  let num_users = res.rows.length;
  let counter = 0;

  if(equal_hands && num_users > cards.length || cards.length == 0) {
    return false;
  }

  let total_cards = Math.min(num_users * to_deal, cards.length);
  console.log("total cards = " + total_cards)

  var hand_updates = new Array(total_cards);
  while(counter < total_cards && counter < cards.length) {
    hand_updates[counter] = client.query("UPDATE cards SET uid = $1, state = 'hand' WHERE cid = $2", 
      [res.rows[counter % num_users].uid, cards[counter].cid]);
    counter++;
  }
  let remaining_cards = cards.length - counter;
  await Promise.all(hand_updates);
  broadcast_cards(gid, remaining_cards);
  return true;
}

async function deal_single_player(gid, uid, to_deal) {
  let res = await client.query("WITH added_cards AS (\
    SELECT cid FROM cards WHERE gid = $1 AND state='deck' ORDER BY random() LIMIT $2\
    ) UPDATE cards SET state = 'hand', uid = $3 FROM added_cards WHERE cards.cid = added_cards.cid;", 
    [gid, to_deal, uid]);

  res = await client.query("SELECT * FROM cards WHERE gid = $1 AND state = 'deck';", [gid]);

  broadcast_cards(gid, res.rows.length);
}

function broadcast_cards(gid, remaining_cards) {
  client.query("SELECT * FROM cards WHERE gid = $1 AND (state = 'hand' OR state = 'table');", [gid])
  .then(res => {
    console.log("sending deal message");
    console.log(res.rows);
    io.to(gid).emit('card update', {
      cards: res.rows,
      remaining: remaining_cards
    });
  });
}

function play_card(cid) {
  client.query("UPDATE cards SET state = 'table' WHERE cid = $1;", [cid]);
}

function guess_card(uid, cid) {
  client.query("UPDATE users SET guess = $1 WHERE uid = $2;", [cid, uid]);
}

function update_roster(gid) {
  client.query("DELETE FROM users WHERE gid = $1 AND state = 'left' RETURNING uid;");
}

function update_player_states(gid, turn, turn_state, other_state) {
  client.query("UPDATE users SET state = $1 WHERE gid = $2 AND uid != $3 AND state != 'left';", 
    [other_state, gid, turn]);
  client.query("UPDATE users SET state = $1 WHERE gid = $2 AND uid = $3 AND state != 'left';", 
    [turn_state, gid, turn]); 
}

async function reset_game(gid) {
  client.query("DELETE FROM users WHERE gid = $1 AND state = 'left';", [gid]);
  client.query("UPDATE users SET score = 0, state = 'join', guess = NULL WHERE gid = $1;", [gid]);
  client.query("UPDATE games SET state = 'pregame', round_number = 0 WHERE gid = $1;", [gid]);
}

async function initialize_game(gid, options) {
  console.log("options:");
  console.log(options);

  let deck_limit = -1;
  if(options.deck_limit_on) {
    deck_limit = options.deck_limit;
  }

  let win_score = 0;
  if(options.win_score_on) {
    win_score = options.win_score;
  }

  let round_limit = 0;
  if(options.round_limit_on) {
    round_limit = options.round_limit;
  }

  let deck_hex_code = "";
  if(options.custom_deck_on) {
    deck_hex_code = options.custom_deck;
    console.log("Custom deck: "+ deck_hex_code);
  }

  client.query("UPDATE games SET hand_size = $1, equal_hands = $2, win_score = $3, round_limit = $4 WHERE gid = $5;",
    [options.hand_size, options.equal_hands, win_score, round_limit, gid]);

  await client.query("DELETE FROM cards WHERE gid = $1", [gid]);
  await setup_cards(gid, deck_limit, options.artists, deck_hex_code);

  await fix_recencies(gid);
  
  deal_cards(gid, options.hand_size);
  begin_game(gid);
}

async function shuffle_player_order(gid) {
  console.log("shuffling player order");
  let res = await client.query("SELECT state FROM games WHERE gid = $1;", [gid]);
  if(res.rows[0].state != 'pregame') {
    return;
  } 
  res = await client.query("SELECT uid FROM users WHERE gid = $1 AND state != 'left';", [gid]);
  let n = res.rows.length;
  let order = shuffle([...Array(n).keys()]);
  let player_order_update = new Array(n);
  for(let i = 0;i < n; i++) {
    player_order_update[i] = client.query("UPDATE users SET turn_recency = $1, turn_order = $2 WHERE uid = $3;", 
      [(2*n - order[i] - 1) % n, order[i], res.rows[i].uid]);
  }
  await Promise.all(player_order_update);
  io.to(gid).emit("player update");
}

function receive_prompt(data) {
  update_player_states(data.gid, data.uid, 'idle', 'wait');
  client.query("UPDATE games SET prompt = $1 WHERE gid = $2;",
    [data.prompt, data.gid]);

  play_card(data.cid);
  update_game_state(data.gid, 'secret');
}

function shuffle(array) {
  let n = array.length;
  let shuffled = new Array(n);
  let indices = [...Array(n).keys()];

  for(let i = 0;i < n; i++) {
    index = indices.splice(Math.floor(Math.random() * (n - i)), 1)[0];
    shuffled[index] = array[i];
  }
  return shuffled;
}

async function player_acts(gid, uid) {
   await client.query("UPDATE users SET state = 'idle' WHERE gid = $1 AND uid = $2 AND state != 'left';",
    [gid, uid]);
}

async function players_ready(gid) {
  res = await client.query("SELECT uid FROM users WHERE gid = $1 AND state = 'wait';",
    [gid]);

  return (res.rows.length == 0);
}

async function fix_recencies(gid, turn) {
  let res = await client.query("SELECT uid FROM users WHERE gid = $1 AND state != 'left' ORDER BY turn_order DESC;",
    [gid]);
  let num_players = res.rows.length;
  console.log("Fixing recencies");
  console.log(res);
  let turn_index = num_players - 1;
  if(turn) {
    turn_index = res.rows.findIndex((user) => {return user.uid == turn;});
  }

  for(let i = 0;i < num_players;i++) {
    client.query("UPDATE users SET turn_recency = $1 WHERE uid = $2;", 
      [((i - turn_index - 1) % num_players + num_players) % num_players, 
      res.rows[i].uid]);
  }
}

async function update_scores(gid) {

  //these three could be wrapped into a single promise rather than done sequentially but *shrug*
  let res = await client.query("SELECT * FROM cards WHERE gid = $1 AND state = 'table';", [gid]);

  let played_cards = new Map();
  for (let card of res.rows) {
    played_cards.set(card.cid, card);
  }

  res = await client.query("SELECT * FROM users WHERE gid = $1;", [gid]);
  let players = res.rows;

  let game_data = await get_gid_data(gid);

  let all_correct = true;
  let all_incorrect = true;
  let provisional_point_changes = new Map();
  let point_changes = new Map();
  for (let player of players) {
    provisional_point_changes.set(player.uid, 0);
    point_changes.set(player.uid, 0);
  }

  for (let player of players) {
    if(player == game_data.turn || !player.guess) {
      continue;
    }
    let opp_uid = played_cards.get(player.guess).uid;
    if(opp_uid == game_data.turn) {
      provisional_point_changes.set(player.uid, 3);
      all_incorrect = false;
    } else {
      point_changes.set(opp_uid, point_changes.get(opp_uid) + 1);
      all_correct = false;
    }
  }
  provisional_point_changes.set(game_data.turn, 3);

  let score_updates = new Array();
  for (let player of players) {
    score_updates.push(
      new Promise((resolve, reject) => {
        let point_change = point_changes.get(player.uid);
        if(!all_correct && !all_incorrect) {
          point_change += provisional_point_changes.get(player.uid);
        } else if(player.uid != game_data.turn) {
          point_change += 2
        }
        resolve(client.query("UPDATE users SET score = score + $1 WHERE uid = $2;",
            [point_change, player.uid]));
    }));
  }
  await Promise.all(score_updates);
}

async function advance_turn(gid) {

  await update_scores(gid);

  await client.query("DELETE FROM users WHERE gid = $1 AND state = 'left';", [gid]);

  client.query("SELECT * FROM users WHERE gid = $1;", [gid]).then((res) => {
    io.to(gid).emit("end turn", res.rows);
  });

  await client.query("UPDATE games SET round_number = round_number + 1 WHERE gid = $1", [gid]);
  
  let game_ended = await check_game_end(gid);

  if(game_ended) {
    end_game(gid);
    return;
  }

  const res = await client.query("WITH updated AS (\
    UPDATE users SET turn_recency = turn_recency + 1, guess = NULL WHERE gid = $1 RETURNING uid, turn_recency)\
    SELECT * FROM updated ORDER BY turn_recency DESC;", [gid]);

  deal_cards(gid, 1);  

  let turn_uid = res.rows[0].uid;
  await client.query("UPDATE users SET turn_recency = 0 WHERE uid = $1;", [turn_uid]);


  begin_turn(gid);
}

async function begin_turn(gid) {
  let res = await client.query("SELECT uid FROM users WHERE gid = $1 AND state != 'left' ORDER BY turn_recency DESC;", 
    [gid]);

  let num_users = res.rows.length;

  if(num_users < 1) {
    return;
  }

  let next_player = res.rows[0].uid;

  client.query("UPDATE cards SET state = 'discard' WHERE gid = $1 AND state = 'table';", [gid]);

  update_player_states(gid, next_player, 'wait', 'idle');

  res = await client.query("UPDATE games SET turn = $1, state = 'prompt' WHERE gid = $2 RETURNING *;", 
    [next_player, gid]);

  io.to(gid).emit('round prompt', {
      uid:next_player,
      game_data:res.rows[0]
    });
}

async function start_guess_round(gid, turn) {
  update_game_state(gid, 'guess');
  update_player_states(gid, turn, 'idle', 'wait');

  const res = await client.query("SELECT * FROM cards WHERE state = 'table' AND gid = $1", [gid]);
  let num_cards = res.rows.length;

  let order = shuffle([...Array(num_cards).keys()]);
  
  for(let i = 0;i < num_cards; i++) {
    client.query("UPDATE cards SET display_order = $1 WHERE cid = $2;", [order[i], res.rows[i].cid]);
  }

  io.to(gid).emit("round guess", {
    order:order
  });
}

async function get_users(gid, callback) {
  try {
      if(gid != 0) {
        var res = await client.query("SELECT * FROM users WHERE gid = $1;", [gid]);
      } else {
        var res = await client.query("SELECT * FROM users;");
      }
      callback(res.rows);
  } catch(err) {
    console.log(err.stack);
  }
}

async function end_game(gid) {
  update_game_state(gid, "end");
  const res = await client.query("SELECT * FROM users WHERE score = (SELECT MAX(score) FROM users);");
  let data = {
    winners:res.rows
  };
  io.to(gid).emit("end game", data);
}

function delete_game(gid) {
  client.query("DELETE FROM games WHERE gid = $1;", [gid]);
  io.to(gid).emit("delete game");
}

async function check_game_end(gid) {

  //this is super naive but let's run with it

  let res = await client.query("SELECT * FROM cards WHERE gid = $1 AND state = 'hand';", [gid]);
  let num_cards = res.rows.length;

  res = await client.query("SELECT * FROM users WHERE gid = $1 AND state != 'left' ORDER BY score DESC;", [gid]);
  let num_users = res.rows.length;

  if(num_users > num_cards) {
    return true;
  }

  let game_data = await get_gid_data(gid);

  if(num_users > 0 && res.rows[0].score >= game_data.win_score
    && game_data.win_score > 0) {
    return true;
  }

  if(game_data.round_number >= game_data.round_limit && game_data.round_limit > 0) {
    return true;
  }

  return false;
}

function retrieve_artists(data, callback) {
  client.query("SELECT artist, COUNT(artist) FROM default_cards GROUP BY artist ORDER BY artist;").then(
    res => {
      callback(res.rows);
  }).catch(err => report_sql_error(err, data.gid));
}

io.set('transports', ['websocket']);

io.on('connection', (socket) => {
	console.log("New connection.");
	socket.on("join game", (data, callback) => {
		
    console.log("User wants to join game.");
		console.log(data);

    join_game(socket, data.username, data.game, data.session_id, callback);
	});

  socket.on("delete all", () => {
    delete_all_data();
  });

  socket.on("get users", (game, callback) => {
    get_users(game, callback);
  });

  socket.on("start game", (data) => {
    initialize_game(data.gid, data.options);
  });

  socket.on("prompt", (data, callback) => {
    console.log("got prompt");
    console.log(data);

    receive_prompt(data);
    
    io.to(data.gid).emit("other prompt", data);
    callback();
  });

  socket.on("choose secret", async data => {
    play_card(data.cid);
    io.to(data.gid).emit("other secret", data);
    await player_acts(data.gid, data.uid);
    if(await players_ready(data.gid)) {
      start_guess_round(data.gid, data.turn);
    }
  });

  socket.on("guess card", async data => {
    guess_card(data.uid, data.cid);
    io.to(data.gid).emit("other guess", data);
    await player_acts(data.gid, data.uid);
    if(await players_ready(data.gid)) {
      advance_turn(data.gid);
    }
  });

  /*socket.on("score update", data => {
    update_score(data.uid, data.score);
  });*/

  socket.on("get cards", async data => {
    num_remaining = await get_remaining_cards(data.gid);
    broadcast_cards(data.gid, num_remaining);
  });

  socket.on("disconnect", (reason) => {
    console.log("client disconnected. reason: "+ reason);
  });

  socket.on("reset game", data => {
    console.log("Received reset request");
    reset_game(data.gid);
    io.to(data.gid).emit("reset game");
  });

  socket.on("shuffle players", data => {
    shuffle_player_order(data.gid);
  });

  socket.on("leave game", data => {
    leave_game(socket, data.uid, data.gid);
  });

  socket.on("delete game", data => {
    console.log("Received delete request");
    delete_game(data.gid);
  });

  socket.on("get artists", (data, callback) => {
    retrieve_artists(data, callback);
  });

  socket.on("form sync", data => {
    socket.to(data.gid).emit("form sync", data);
    console.log("received form sync message");
    console.log(data);
  });

  socket.on("form request", data => {
    socket.to(data.gid).emit("form request", data.form_id);
  });

});