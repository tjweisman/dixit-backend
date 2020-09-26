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
	filename VARCHAR NOT NULL
);

INSERT INTO default_cards(filename) VALUES 
('teddy_0.png'),
('teddy_1.png'),
('teddy_2.png'),
('teddy_3.png'),
('teddy_4.png'),
('teddy_5.png'),
('teddy_6.png'),
('teddy_7.png'),
('teddy_8.png'),
('teddy_9.png'),
('teddy_10.png'),
('teddy_11.png'),
('teddy_12.png'),
('teddy_13.png'),
('teddy_14.png'),
('cas_0.png'),
('cas_1.png'),
('cas_2.png'),
('cas_3.png'),
('cas_4.png'),
('cas_5.png'),
('cas_6.png'),
('cas_7.png'),
('cas_8.png'),
('cas_9.png'),
('cas_10.png'),
('cas_11.png'),
('cas_12.png'),
('cas_13.png'),
('cas_14.png'),
('cas_15.png'),
('cas_16.png'),
('cas_17.png'),
('cas_18.png'),
('neza_0.png'),
('neza_1.png'),
('neza_2.png'),
('neza_3.png'),
('neza_4.png'),
('neza_5.png'),
('neza_6.png'),
('neza_7.png'),
('neza_8.png'),
('neza_9.png'),
('neza_10.png'),
('neza_11.png'),
('neza_12.png'),
('neza_13.png'),
('rok_0.png'),
('rok_1.png'),
('rok_2.png'),
('rok_3.png'),
('rok_4.png'),
('rok_5.png');

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