DROP TABLE IF EXISTS users, games, cards, default_cards;

DROP TYPE IF EXISTS card_state;

CREATE TABLE users(
	
	uid SERIAL UNIQUE,
	name varchar(40) NOT NULL,
	game varchar(40) NOT NULL,
	gid INTEGER,
	score INTEGER DEFAULT 0,
	turn_order SERIAL,
	player_action INTEGER DEFAULT 0,
	PRIMARY KEY(uid),

	CONSTRAINT user_game UNIQUE(name, game)
);

CREATE TABLE games(
	gid SERIAL UNIQUE,
	name varchar(40) CONSTRAINT name_unique UNIQUE NOT NULL,
	turn INTEGER,
	in_progress BOOLEAN DEFAULT FALSE,
	hand_size INTEGER DEFAULT 4,
	PRIMARY KEY(gid),

	CONSTRAINT fk_turn FOREIGN KEY(turn) REFERENCES users(uid) ON DELETE SET NULL
);

ALTER TABLE users ADD CONSTRAINT fk_game FOREIGN KEY(gid) REFERENCES games(gid)
ON DELETE CASCADE;

CREATE TABLE default_cards(
	filename VARCHAR NOT NULL
);

INSERT INTO default_cards(filename) VALUES ('card1.png'), ('card2.png'), 
('card3.png'), ('card4.png'), ('card5.png'), ('card6.png'), ('card7.png'), ('card8.png'),
('card9.png'), ('card10.png'), ('card11.png'), ('card12.png'), ('card13.png'), ('card14.png'),
('card15.png');

CREATE TYPE card_state AS ENUM ('deck', 'hand', 'discard');

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