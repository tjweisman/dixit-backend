DROP TABLE IF EXISTS users, games, cards, default_cards;

DROP TYPE IF EXISTS card_state, game_state;

CREATE TABLE users(
	
	uid SERIAL UNIQUE,
	name varchar(40) NOT NULL,
	game varchar(40) NOT NULL,
	gid INTEGER,
	score INTEGER DEFAULT 0,
	turn_order SERIAL,
	player_action INTEGER DEFAULT 0,
	socket VARCHAR DEFAULT NUll,
	PRIMARY KEY(uid),

	CONSTRAINT user_game UNIQUE(name, game)
);

CREATE TYPE game_state AS ENUM ('pregame', 'prompt', 'secret', 'guess');

CREATE TABLE games(
	gid SERIAL UNIQUE,
	name varchar(40) CONSTRAINT name_unique UNIQUE NOT NULL,
	turn INTEGER,
	turn_index INTEGER DEFAULT 0,
	state game_state DEFAULT 'pregame',
	hand_size INTEGER DEFAULT 4,
	prompt VARCHAR,
	PRIMARY KEY(gid),

	CONSTRAINT fk_turn FOREIGN KEY(turn) REFERENCES users(uid) ON DELETE SET NULL
);

ALTER TABLE users ADD CONSTRAINT fk_game FOREIGN KEY(gid) REFERENCES games(gid)
ON DELETE CASCADE;

CREATE TABLE default_cards(
	filename VARCHAR NOT NULL UNIQUE
);

CREATE TYPE card_state AS ENUM ('deck', 'hand', 'table', 'discard');

CREATE TABLE cards(
	cid SERIAL UNIQUE,
	filename VARCHAR,
	uid INTEGER,
	gid INTEGER NOT NULL,
	state card_state NOT NULL DEFAULT 'deck',

	PRIMARY KEY(cid),
	CONSTRAINT fk_game FOREIGN KEY(gid) REFERENCES games(gid) ON DELETE CASCADE,
	CONSTRAINT fk_user FOREIGN KEY(uid) REFERENCES users(uid) ON DELETE SET NULL
);
