var dgram = require('dgram');
var SmartBuffer = require('smart-buffer');

var Answer = function() {
    this.compressed = false;
	this.parts = [];
};

Answer.prototype.add = function(id, reader) {
	if ((id & 0x80000000) !== 0) {
		this.compressed = true;
	}
	this.totalpackets = reader.readUInt8();
	var packetnum = reader.readUInt8();
	if(packetnum >= this.totalpackets) {
		return; // Invalid response
	}
	
	this.parts[packetnum] = reader;
};
Answer.prototype.isComplete = function() {
	return (this.parts.filter(function(item) { return !!item; }).length == this.totalpackets);
};
Answer.prototype.assemble = function() {
	var combined = [];
	for (var i = 0; i < this.parts.length; i++) {
		var reader = this.parts[i];
		reader.skip(i === 0 ? 6 : 2);
        combined.push(reader.toBuffer().slice(reader.length - reader.remaining()));
	}
	
	for(var i = 0; i < combined.length; i++) {
		var output = '';
		var pointer = 0;
		while(pointer < combined[i].length) {
			var text = '';
			for(j = 0; j < 16 && pointer < combined[i].length; j++) {
				var num = combined[i].readInt8(pointer).toString(16);
				if(num.length == 1) {
					num = '0' + num;
				}
				
				output += num + ' ';
				text += String.fromCharCode(combined[i].readInt8(pointer));
				pointer++;
			}
			
			output += "\t\t\t" + text + "\n";
		}
	}
	
    var payload = Buffer.concat(combined);
    if (this.compressed) {
        console.warn('COMPRESSION NOT SUPPORTED. PAYLOAD:', payload);
    }
	
    return payload;
};

var SQUnpacker = function(messageEmitter, timeout) {
    this.timeout = timeout || 1000;
	this.answers = {};
	this.messageEmitter = messageEmitter;
	this.messageEmitter.on('message', this.readMessage.bind(this));
}

SQUnpacker.prototype = Object.create(require('events').EventEmitter.prototype);

SQUnpacker.prototype.readMessage = function(buffer, remote){
    var that = this;
    
	var reader = new SmartBuffer(buffer);
	var header = reader.readInt32LE();
	buffer = buffer.slice(4);

	if (header == -1) {
		// No need to build an Answer, this is a single-packet response
		this.emit('message', buffer, remote);
		return;
	}
	
	if (header == -2) {
		// Split response
		var ansID = reader.readInt32LE();
		var ans = this.answers[ansID];
		if (!ans) {
			ans = this.answers[ansID] = new Answer();
            setTimeout(function(){
                // ensure that answers are not stored forever - discard after a timeout period
                // this simply cleans up partial-responses
                delete that.answers[ansID];
            }, this.timeout);
		}
		ans.add(ansID, reader);
		
		if (ans.isComplete()) {
			this.emit('message', ans.assemble(), remote);
			delete this.answers[ansID];
		}
	}
};

var SourceQuery = function(timeout){
    timeout = timeout || 1000;

    var sq = this;
	
	var openQueries = 0;
	var closingSocketCb;
	var queryEnded = function(){
		openQueries--;
		if (!openQueries && !!closingSocketCb) {
			sq.client.close();
			closingSocketCb();
		}
	};
    
    var ids = {
        A2S_INFO: 'T',
        S2A_INFO: 'I',
        
        A2S_SERVERQUERY_GETCHALLENGE: 'W',
        S2A_SERVERQUERY_GETCHALLENGE: 'A',
        
        A2S_PLAYER: 'U',
        S2A_PLAYER: 'D',
        
        A2S_RULES: 'V',
        S2A_RULES: 'E'
    };
    
    var send = function(writer, responseCode, cb) {
		cb = cb || function(){};
		openQueries++;
		var buffer = writer.toBuffer();
		
		if(typeof responseCode === 'string') {
			responseCode = responseCode.charCodeAt(0);
		}
		
        sq.client.send(buffer, 0, buffer.length, sq.port, sq.address, function(err, bytes){
            var giveUpTimer;
        
            if (err) {
                cb(err, null);
				queryEnded();
                return;
            }
            
            var relayResponse = function(buffer, remote){
                if (buffer.length < 1)
                    return;
                
				var reader = new SmartBuffer(buffer);
				
				var res = reader.readUInt8();
                if (res !== responseCode)
                    return;
                
                sq.squnpacker.removeListener('message', relayResponse);
                clearTimeout(giveUpTimer);
                cb(null, reader);
				queryEnded();
            };
            
            giveUpTimer = setTimeout(function(){
                sq.squnpacker.removeListener('message', relayResponse);
                cb('timeout', null);
				queryEnded();
            }, timeout);
            
            sq.squnpacker.on('message', relayResponse);
        });
    };
    
    var combine = function(keys, values) {
        var pairs = {};
        for (var i = 0; i < values.length; i++) {
            pairs[keys[i]] = values[i];
        }
        return pairs;
    };

    sq.open = function(address, port, errorHandler) {
        sq.address = address;
        sq.port = port;
        sq.client = dgram.createSocket('udp4');
        sq.client.on('error', errorHandler || function(){});
        sq.squnpacker = new SQUnpacker(sq.client);
    };
    
    sq.getChallengeKey = function(reqType, cb) {
		cb = cb || function(){};
		var writer = new SmartBuffer();
		writer.writeInt32LE(-1);
		writer.writeUInt8(reqType.charCodeAt(0));
		writer.writeInt32LE(-1);
        send(writer, ids.S2A_SERVERQUERY_GETCHALLENGE, function(err, reader){
            if (err) {
                cb(err, reader);
                return;
            }
            
            cb(null, reader.readInt32LE());
        });
    };
    
    sq.getInfo = function(cb) {
		cb = cb || function(){};
		var writer = new SmartBuffer();
		writer.writeInt32LE(-1);
		writer.writeUInt8(ids.A2S_INFO.charCodeAt(0));
		writer.writeStringNT("Source Engine Query");
        send(writer, ids.S2A_INFO, function(err, reader){
            if (err) {
                cb(err, reader);
                return;
            }
            
			var info = {
				"protocol": reader.readInt8(),
				"name": reader.readStringNT(),
				"map": reader.readStringNT(),
				"folder": reader.readStringNT(),
				"game": reader.readStringNT(),
				"appid": reader.readInt16LE(),
				"players": reader.readUInt8(),
				"maxplayers": reader.readUInt8(),
				"bots": reader.readUInt8(),
				"servertype": String.fromCharCode(reader.readUInt8()),
				"environment": String.fromCharCode(reader.readUInt8()),
				"password": reader.readUInt8(),
				"secure": reader.readUInt8()
			};
            
            // if "The Ship"
            if (info.appid == 2400) {
				info['ship-mode'] = reader.readInt8();
				info['ship-witnesses'] = reader.readInt8();
				info['ship-duration'] = reader.readInt8();
            }
            
            info.version = reader.readStringNT();
            
            if (reader.remaining() > 1) {
                var EDF = reader.readInt8();
                
                if ((EDF & 0x80) !== 0) {
                    info.port = reader.readInt16LE();
                }
                
                if ((EDF & 0x10) !== 0) {
                    info.steamID = reader.readInt32LE(); // This gives is the accountid
					info.steamIDUpper = reader.readInt32LE();
                }
                
                if ((EDF & 0x40) !== 0) {
                    info['tv-port'] = reader.readInt16LE();
                    info['tv-name'] = reader.readStringNT();
                }
                
                if ((EDF & 0x20) !== 0) {
                    info.keywords = reader.readStringNT();
                }
                
                if ((EDF & 0x01) !== 0) {
                    info.gameID = reader.readInt32LE();
                }
            }
            
            cb(null, info);
        });
    };
    
    sq.getPlayers = function(cb) {
		cb = cb || function(){};
        sq.getChallengeKey(ids.A2S_PLAYER, function(err, key){
            if (err) {
                cb(err, key);
                return;
            }
			
			var writer = new SmartBuffer();
			writer.writeInt32LE(-1);
			writer.writeUInt8(ids.A2S_PLAYER.charCodeAt(0));
			writer.writeInt32LE(key);
        
            send(writer, ids.S2A_PLAYER, function(err, reader){
                if (err) {
                    cb(err, reader);
                    return;
                }
            
                var playerCount = reader.readUInt8();
                var players = [];
                for (var i = 0; i < playerCount; i++) {
					players.push({
						"index": reader.readUInt8(),
						"name": reader.readStringNT(),
						"score": reader.readInt32LE(),
						"online": reader.readFloatLE()
					});
                }
                cb(null, players);
            });
        });
    };
    
    sq.getRules = function(cb) {
		cb = cb || function(){};
        sq.getChallengeKey(ids.A2S_RULES, function(err, key){
            if (err) {
                cb(err, key);
                return;
            }
			
			var writer = new SmartBuffer();
			writer.writeInt32LE(-1);
			writer.writeUInt8(ids.A2S_RULES.charCodeAt(0));
			writer.writeInt32LE(key);
        
            send(writer, ids.S2A_RULES, function(err, reader){
                if (err) {
                    cb(err, reader);
                    return;
                }
            
                var ruleCount = reader.readInt16LE();
                var rules = {};
                for (var i = 0; i < ruleCount; i++) {
                    var name = reader.readStringNT();
					var value = reader.readStringNT();
					rules[name] = value;
                }
                cb(null, rules);
            });
        });
    };
    
    sq.close = function(cb) {
		cb = cb || function(){};
		if (openQueries > 0) {
			closingSocketCb = cb;
		} else {
			sq.client.close();
			cb();
		}
    };
};

module.exports = SourceQuery;
