DROP TABLE IF EXISTS users, games, cards, default_cards;

DROP TYPE IF EXISTS card_state, game_state, player_state;

CREATE TYPE player_state AS ENUM ('wait', 'idle', 'left', 'join');

CREATE TABLE users(
	
	uid SERIAL UNIQUE,
	name varchar(40) NOT NULL,
	game varchar(40) NOT NULL,
	gid INTEGER,
	score INTEGER DEFAULT 0,
	turn_recency SERIAL,
	turn_order SERIAL,
	state player_state DEFAULT 'join',
	guess INTEGER,
	session_id VARCHAR DEFAULT NUll,
	PRIMARY KEY(uid),

	CONSTRAINT user_game UNIQUE(name, game)
);

CREATE TYPE game_state AS ENUM ('pregame', 'prompt', 'secret', 'guess', 'end');

CREATE TABLE games(
	gid SERIAL UNIQUE,
	name varchar(40) CONSTRAINT name_unique UNIQUE NOT NULL,
	turn INTEGER,
	state game_state DEFAULT 'pregame',
	hand_size INTEGER DEFAULT 4,
	equal_hands BOOLEAN DEFAULT TRUE,
	win_score INTEGER DEFAULT 0,
	round_limit INTEGER DEFAULT 0,
	round_number INTEGER DEFAULT 0,
	prompt VARCHAR,
	PRIMARY KEY(gid),

	CONSTRAINT fk_turn FOREIGN KEY(turn) REFERENCES users(uid) ON DELETE SET NULL
);

ALTER TABLE users ADD CONSTRAINT fk_game FOREIGN KEY(gid) REFERENCES games(gid)
ON DELETE CASCADE;

CREATE TABLE default_cards(
	filename VARCHAR NOT NULL UNIQUE,
	artist VARCHAR,
	date_added DATE
);

CREATE TYPE card_state AS ENUM ('deck', 'hand', 'table', 'discard', 'ordered');

CREATE TABLE cards(
	cid SERIAL UNIQUE,
	filename VARCHAR,
	artist VARCHAR,
	uid INTEGER,
	gid INTEGER NOT NULL,
	state card_state NOT NULL DEFAULT 'deck',
	display_order INTEGER CHECK (display_order > 0),

	PRIMARY KEY(cid),
	CONSTRAINT fk_game FOREIGN KEY(gid) REFERENCES games(gid) ON DELETE CASCADE,
	CONSTRAINT fk_user FOREIGN KEY(uid) REFERENCES users(uid) ON DELETE SET NULL
);
