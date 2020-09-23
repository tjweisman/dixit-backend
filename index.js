const PORT = process.env.PORT || 3000;
const app = require('express')();
const http = require('http').createServer(app);
var io = require('socket.io')(http);

const { Client } = require('pg');

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


async function join_game(socket, username, game, callback) {
  var uid;
  var response_data = {
    username:username,
    game:game
  };
  client.query("INSERT INTO users(name, game) VALUES($1, $2) RETURNING uid",
      [username, game])
    .then(async res => {
      uid = res.rows[0].uid;
      return await client.query("INSERT INTO games(name, turn) VALUES($1, $2) \
      ON CONFLICT ON CONSTRAINT name_unique DO UPDATE SET name = EXCLUDED.name RETURNING gid;",
      [game, uid]).catch(err => {handle_generic_error(err, response_data, callback);});
    })
    .then(res => {
      client.query("UPDATE users SET gid = $1 WHERE uid = $2;",
        [res.rows[0].gid, uid]).catch(err => {handle_generic_error(err, response_data, callback);});

      socket.join(res.rows[0].gid);

      response_data.response = "success";
      response_data.uid = uid;
      response_data.gid = res.rows[0].gid;

      callback(response_data);
      io.to(res.rows[0].gid).emit("player join");


      console.log("user " + username + " joined game "+ game);
    }).catch(err => {
      if(err.code == 23505 && err.constraint == "user_game") {
        response_data.response = "error";
        response_data.error = "user_in_game";
        callback(response_data);
      } else {
        handle_generic_error(err, response_data, callback);
      }
    });
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

async function setup_cards(gid) {
  await client.query("INSERT INTO cards(filename, gid) (SELECT filename, gid FROM default_cards INNER JOIN games ON $1 = gid);",
    [gid]);
}

function begin_game(gid) {
  client.query("UPDATE games SET in_progress = TRUE WHERE gid = $1;",
    [gid]);
}

async function deal_cards(gid, to_deal) {

  let res = await client.query("SELECT cid, filename FROM cards WHERE gid = $1 AND state='deck' ORDER BY random();", [gid]);
  cards = res.rows;

  name = await get_room_name(gid);

  res = await client.query("SELECT uid FROM users WHERE game = $1;", [name]);
  let num_users = res.rows.length;
  let counter = 0;
  let total_cards = Math.min(num_users * to_deal, cards.length);
  console.log("total cards = " + total_cards)

  var hand_updates = new Array(total_cards);
  while(counter < total_cards) {
    hand_updates[counter] = client.query("UPDATE cards SET uid = $1, state = 'hand' WHERE cid = $2", 
      [res.rows[counter % num_users].uid, cards[counter].cid]);
    counter++;
  }
  await Promise.all(hand_updates);
}

function broadcast_hands(gid) {
  client.query("SELECT cid, filename, uid FROM cards WHERE gid = $1 AND state = 'hand';", [gid])
  .then(res => {
    console.log("sending deal message");
    console.log(res.rows);
    io.to(gid).emit('user hands', {
      cards: res.rows
    })
  });
}

function broadcast_turn(gid) {
  client.query("SELECT turn FROM games WHERE gid = $1;", [gid])
  .then(async res => {
    username = await get_username(res.rows[0].turn);
    io.to(gid).emit('turn', {
      uid:res.rows[0].turn,
      username: username
    });
  });
}

async function initialize_game(gid) {
  await client.query("DELETE FROM cards WHERE gid = $1", [gid]);
  await setup_cards(gid);
  let hs_resp = await client.query("SELECT hand_size FROM games WHERE gid = $1;", [gid]);
  await deal_cards(gid, hs_resp.rows[0].hand_size);

  begin_game(gid);
  broadcast_hands(gid);
  broadcast_turn(gid);
  io.to(gid).emit('start game');
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

    join_game(socket, data["username"], data["game"], callback);
	});

  socket.on("delete all", () => {
    delete_all_data();
  });

  socket.on("get users", (game, callback) => {
    get_users(game, callback);
  });

  socket.on("start game", (gid) => {
    initialize_game(gid);
  });

  socket.on("prompt", (data, callback) => {
    console.log("got prompt");
    console.log(data);
    io.to(data.gid).emit("prompt", data);
    callback();
  });

});