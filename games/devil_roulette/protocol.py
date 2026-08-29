"""恶魔轮盘赌 WebSocket 协议常量。"""

PROTOCOL_VERSION = 1

MIN_PLAYERS = 2
MAX_PLAYERS = 6
STARTING_HP = 4
ITEMS_PER_ROUND = 2
DISCONNECT_GRACE_SECONDS = 30

ITEM_IDS = ("auto", "split", "detector", "accelerater")

# Client → Server
MSG_JOIN = "join"
MSG_LEAVE = "leave"
MSG_START_GAME = "start_game"
MSG_USE_ITEM = "use_item"
MSG_SHOOT = "shoot"

# Server → Client
MSG_ROOM_STATE = "room_state"
MSG_GAME_STATE = "game_state"
MSG_DETECTOR_RESULT = "detector_result"
MSG_SHOT_FIRED = "shot_fired"
MSG_TURN_CHANGED = "turn_changed"
MSG_RELOAD = "reload"
MSG_PLAYER_ELIMINATED = "player_eliminated"
MSG_GAME_OVER = "game_over"
MSG_ERROR = "error"
MSG_PLAYER_JOIN = "player_join"
MSG_PLAYER_LEAVE = "player_leave"
MSG_ROOM_REMOVED = "room_removed"
