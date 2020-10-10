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

function handle_generic_error(err, data, callback) {
  console.log(err.stack);
  data.response = "error";
  data.error = "unknown";
  callback(data);
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
      ON CONFLICT ON CONSTRAINT name_unique DO UPDATE SET name = EXCLUDED.name RETURNING gid, state;",
      [game, uid]).catch(err => {handle_generic_error(err, response_data, callback);});
    })
    .then(res => {

      let session_id = uuidv4();

      client.query("UPDATE users SET gid = $1, session_id = $3 WHERE uid = $2;",
        [res.rows[0].gid, uid, session_id]).catch(err => {handle_generic_error(err, response_data, callback);});

      socket.join(res.rows[0].gid);

      response_data.response = "success";
      response_data.uid = uid;
      response_data.gid = res.rows[0].gid;
      response_data.session_id = session_id;
      response_data.game_data = {
        state:res.rows[0].state
      }

      callback(response_data);
      socket.to(res.rows[0].gid).emit("player join");


      console.log("new user " + username + " joined game "+ game);
    }).catch(err => {
      if(err.code == 23505 && err.constraint == "user_game") {

        console.log("user " + username + " rejoined game " + game);
        rejoin_user(socket, username, game, callback);

        //response_data.response = "error";
        //response_data.error = "user_in_game";
      } else {
        handle_generic_error(err, response_data, callback);
      }
    });
}

async function rejoin_user(socket, username, game, callback) {
  let response_data = {
    response:"success",
    username:username,
    game:game
  };

  const res = await client.query("SELECT uid, session_id FROM users WHERE name = $1;", 
    [username]);

  game_data = await get_game_data(game);
  response_data.uid = res.rows[0].uid;
  response_data.session_id = res.rows[0].session_id;
  response_data.gid = game_data.gid;
  response_data.game_data = game_data;

  socket.join(game_data.gid);
  callback(response_data);
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
  let res = await client.query("SELECT * FROM users WHERE gid = $1 AND name = $2;",
    [game_data.gid, user]);

  //the game has started and the user doesn't already exist: can't join
  if(!(game_data.state == "pregame") && res.rows.length == 0) {
    join_status.allowed = false;
    join_status.reason = "in_progress"
    return join_status;
  } else if(res.rows.length == 0) {
    return join_status;
  }
  console.log("session id: ");
  console.log(res.rows[0].session_id);
  if(res.rows[0].session_id != session_id) {
    console.log("session ids do not match");
    join_status.allowed = false;
    join_status.reason = "user_connected";
    return join_status;
  }
  return join_status;
}

async function leave_game(socket, uid, gid) {
  socket.leave(gid);

  await client.query("DELETE from users WHERE uid = $1;", [uid]);
  io.to(gid).emit("player join");

  let game_data = await get_gid_data(gid);
  
  if(game_data.state == "prompt") {
    begin_turn(gid);
  } else if(game_data.state == "secret") {
    if(await players_ready(gid)) {
      start_guess_round(data.gid, data.turn);
    }
  } else if(game_data.state == "guess") {
    if(await players_ready(gid)) {
      io.to(data.gid).emit("reveal guess", {});
      advance_turn(gid);
    }
  }
}

function update_game_state(gid, state) {
  client.query("UPDATE games SET state = $1 WHERE gid = $2;",
    [state, gid]);
}

function update_score(uid, score) {
  client.query("UPDATE users SET score = $1 WHERE uid = $2;",
    [score, uid]);
}

function delete_all_data() {
  client.query("DELETE FROM games;");
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

async function get_uid(username) {
  const res = await client.query("SELECT uid FROM users WHERE name = $1;", [username]);
  return res.rows[0].uid;
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

async function get_gid_data(gid) {
  const res = await client.query("SELECT * FROM games WHERE gid = $1;", [gid]);
  return res.rows[0];
}

async function setup_cards(gid) {
  await client.query("INSERT INTO cards(filename, gid, artist) (SELECT filename, gid, artist FROM default_cards INNER JOIN games ON $1 = gid);",
    [gid]);
}

function begin_game(gid) {
  client.query("UPDATE games SET state = 'prompt' WHERE gid = $1;",
    [gid]);
  begin_turn(gid);
  io.to(gid).emit('start game');
}

async function deal_cards(gid, to_deal) {

  let res = await client.query("SELECT cid, filename FROM cards WHERE gid = $1 AND state='deck' ORDER BY random();", [gid]);
  cards = res.rows;

  name = await get_room_name(gid);

  res = await client.query("SELECT equal_hands FROM games WHERE gid = $1;", [gid]);
  let equal_hands = res.rows[0].equal_hands;

  res = await client.query("SELECT uid FROM users WHERE game = $1;", [name]);
  let num_users = res.rows.length;
  let counter = 0;

  if(equal_hands && num_users > cards.length) {
    return;
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
}

function broadcast_cards(gid, remaining_cards) {
  client.query("SELECT cid, filename, uid, state, artist FROM cards WHERE gid = $1 AND state = 'hand' OR state = 'table';", [gid])
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

function update_roster(gid) {
  client.query("DELETE FROM users WHERE gid = $1 AND state = 'left' RETURNING uid;");
}

function update_player_states(gid, turn, turn_state, other_state) {
  client.query("UPDATE users SET state = $1 WHERE gid = $2 AND uid != $3 AND state != 'left';", 
    [other_state, gid, turn]);
  client.query("UPDATE users SET state = $1 WHERE gid = $2 AND uid = $3;", 
    [turn_state, gid, turn]); 
}

async function reset_game(gid) {
  client.query("UPDATE users SET score = 0 WHERE gid = $1;", [gid]);
  client.query("UPDATE games SET state = 'pregame' WHERE gid = $1;", [gid]);
}

async function initialize_game(gid, options) {
  await client.query("DELETE FROM cards WHERE gid = $1", [gid]);
  await setup_cards(gid);

  console.log("options:");
  console.log(options);

  client.query("UPDATE games SET hand_size = $1, equal_hands = $2 WHERE gid = $3;",
    [options.hand_size, options.equal_hands, gid]);
  
  deal_cards(gid, options.hand_size);
  begin_game(gid);
}

async function shuffle_player_order(gid) {
  console.log("shuffling player order");
  let res = await client.query("SELECT state FROM games WHERE gid = $1;", [gid]);
  if(res.rows[0].state != 'pregame') {
    return;
  } 
  res = await client.query("SELECT uid FROM users WHERE gid = $1;", [gid]);
  let n = res.rows.length;
  let order = shuffle([...Array(n).keys()]);
  let player_order_update = new Array(n);
  for(let i = 0;i < n; i++) {
    player_order_update[i] = client.query("UPDATE users SET turn_recency = $1, turn_order = $1 WHERE uid = $2;", 
      [order[i], res.rows[i].uid]);
  }
  await Promise.all(player_order_update);
  io.to(gid).emit("player join");
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
   await client.query("UPDATE users SET state = 'idle' WHERE gid = $1 AND uid = $2;",
    [gid, uid]);
}

async function players_ready(gid) {
  res = await client.query("SELECT uid FROM users WHERE gid = $1 AND state = 'wait';",
    [gid]);

  return (res.rows.length == 0);
}

async function advance_turn(gid) {
  const res = await client.query("WITH updated AS (\
    UPDATE users SET turn_recency = turn_recency + 1 WHERE gid = $1 RETURNING uid, turn_recency)\
    SELECT * FROM updated ORDER BY turn_recency DESC;", [gid]);

  deal_cards(gid, 1);

  let turn_uid = res.rows[0].uid;
  await client.query("UPDATE users SET turn_recency = 0 WHERE uid = $1;", [turn_uid]);

  begin_turn(gid);
}

async function begin_turn(gid) {
  const res = await client.query("SELECT uid FROM users WHERE gid = $1 ORDER BY turn_recency DESC;", 
    [gid]);

  let num_users = res.rows.length;
  let next_player = res.rows[0].uid;

  client.query("UPDATE games SET turn = $1 WHERE gid = $2;", [next_player, gid]);
  client.query("UPDATE cards SET state = 'discard' WHERE gid = $1 AND state = 'table';", [gid]);

  update_player_states(gid, next_player, 'wait', 'idle');

  update_game_state(gid, 'prompt');
  io.to(gid).emit('round prompt', {
      uid:next_player
    });
}

async function start_guess_round(gid, turn) {
  update_game_state(gid, 'guess');
  update_player_states(gid, turn, 'idle', 'wait');

  const res = await client.query("SELECT * FROM cards WHERE state = 'table' AND gid = $1", [gid]);
  let num_cards = res.rows.length;

  io.to(gid).emit("round guess", {
    order:shuffle([...Array(num_cards).keys()])
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
    io.to(data.gid).emit("other guess", data);
    await player_acts(data.gid, data.uid);
    if(await players_ready(data.gid)) {
      io.to(data.gid).emit("reveal guess", {});

      advance_turn(data.gid);
    }
  });

  socket.on("score update", data => {
    update_score(data.uid, data.score);
  });

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

});