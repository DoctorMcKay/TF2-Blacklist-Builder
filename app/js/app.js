function getElement(selector) {
	return document.querySelector(selector);
}

function getElements(selector) {
	return Array.prototype.slice.call(document.querySelectorAll(selector), 0);
}

var DEBUG = false;

var g_ServerList;
var g_Version = require('./package.json').version;

var request = require('request');
var SourceQuery = require('sourcequery');
var async = require('async');
var gui = require('nw.gui');
var win = gui.Window.get();

document.addEventListener("DOMContentLoaded", function() {
	if(DEBUG) {
		win.showDevTools();
	}
	
	document.title = "TF2 Blacklist Builder v" + g_Version;
	
	win.setProgressBar(2); // Indeterminate progress bar
	
	request("https://www.traderep.org/api/v1/serverlist", function(err, response, body) {
		if(err) {
			alert("FATAL ERROR: Couldn't download server list.\n\n" + err);
			win.close();
			return;
		}
		
		try {
			g_ServerList = JSON.parse(body);
		} catch(e) {
			alert("FATAL ERROR: Server list invalid or corrupt.\n\n" + e);
			win.close();
			return;
		}
		
		if(!g_ServerList.success) {
			alert("FATAL ERROR: " + g_ServerList.error);
			win.close();
			return;
		}
		
		win.setProgressBar(-1);
		getElement('progress').value = 0;
		getElement('#loading').style.display = 'none';
		getElement('#main-view').style.display = 'block';
	});
	
	getElement('#quickadd').onchange = function() {
		var values = getElement('#quickadd').value;
		var fields = values.split(';');
		fields.forEach(function(field) {
			var parts = field.split(':');
			var element = getElement('#' + parts[0]);
			var contents = element.value.split(',');
			if(contents.length == 1 && contents[0] == '') {
				contents = [];
			}
			
			if(contents.indexOf(parts[1]) != -1) {
				// Already filtered
				return;
			}
			
			contents.push(parts[1]);
			element.value = contents.join(',');
		});
		
		getElement('#quickadd').value = '';
	};
	
	getElement('#generate').onclick = function() {
		getElements('input, select, button').forEach(function(element) {
			element.disabled = true;
		});
		
		var cleanValue = function(item) {
			return item.trim().toLowerCase();
		};
		
		var names = getElement('#name-contains').value.trim();
		names = (names == '' ? [] : names.split(','));
		names.map(cleanValue);
		
		var tags = getElement('#tags').value.trim();
		tags = (tags == '' ? [] : tags.split(','));
		tags.map(cleanValue);
		
		var maps = getElement('#map').value.trim();
		maps = (maps == '' ? [] : maps.split(','));
		maps.map(cleanValue);
		
		var cvars = getElement('#cvars').value.trim();
		cvars = (cvars == '' ? [] : cvars.split(','));
		cvars.map(cleanValue);
		
		build(names, tags, maps, cvars);
	};
});

function build(names, tags, maps, cvars) {
	var queue = async.queue(function(server, callback) {
		var sq = new SourceQuery(2000);
		sq.open(server.ip, server.port);
		sq.getInfo(function(err, info) {
			if(err) {
				callback(err);
				return;
			}
			
			sq.getRules(function(err, rules) {
				if(err) {
					callback(err);
					return;
				}
				
				callback(null, info, rules);
			});
		});
	}, 50);
	
	var processed = 0;
	var dead = 0;
	var blacklistedServers = [];
	
	g_ServerList.servers.forEach(function(server) {
		queue.push(server, function(err, info, rules) {
			processed++;
			if(err) {
				dead++;
			} else {
				var blacklisted = false;
				var serverName = info.name.toLowerCase();
				for(var i = 0; i < names.length && !blacklisted; i++) {
					if(serverName.indexOf(names[i]) != -1) {
						blacklisted = true;
						blacklistedServers.push([server, info, "Name Contains '" + names[i] + "'"]);
					}
				}
				
				var serverTags = rules['sv_tags'] || '';
				serverTags = serverTags.toLowerCase().split(',');
				for(var i = 0; i < tags.length && !blacklisted; i++) {
					if(serverTags.indexOf(tags[i]) != -1) {
						blacklisted = true;
						blacklistedServers.push([server, info, "Has Tag '" + tags[i] + "'"]);
					}
				}
				
				var serverMap = info.map.toLowerCase();
				for(var i = 0; i < maps.length && !blacklisted; i++) {
					if(serverMap.indexOf(maps[i]) != -1) {
						blacklisted = true;
						blacklistedServers.push([server, info, "Map '" + serverMap + "' Contains '" + maps[i] + "'"]);
					}
				}
				
				for(var i = 0; i < cvars.length && !blacklisted; i++) {
					var parts = cvars[i].split('=');
					if((parts.length == 1 && rules[parts[0]]) || (parts.length == 2 && rules[parts[0]] == parts[1])) {
						if(parts[0] == 'mp_tournament' && parts[1] == 1 && serverTags.indexOf('mvm') != -1) {
							// Ignore mp_tournament in MvM servers
							continue;
						}
						
						blacklisted = true;
						blacklistedServers.push([server, info, "ConVar '" + parts[0] + "'" + (parts.length == 1 ? " Exists" : " = '" + parts[1] + "'")]);
					}
				}
			}
			
			getElement('#progress-text').textContent = "Processed " + processed.toLocaleString() + "/" + g_ServerList.servers.length.toLocaleString() + " servers (" + dead.toLocaleString() + " dead) (" + blacklistedServers.length.toLocaleString() + " blacklisted)";
			
			var progress = processed / g_ServerList.servers.length;
			win.setProgressBar(progress);
			getElement('progress').value = progress;
			document.title = "TF2 Blacklist Builder v" + g_Version + " (" + Math.round(progress * 100) + "%)";
		});
	});
	
	queue.drain = function() {
		var chooser = getElement('#save');
		chooser.addEventListener('change', function() {
			var filename = this.value;
			
			var file = "\"serverblacklist\"\n{\n";
			var date = Math.floor(Date.now() / 1000);
			blacklistedServers.forEach(function(server) {
				file += "\t\"server\"\n\t{\n\t\t\"name\"\t\t\"[BB: " + server[2] + "] " + server[1].name.replace(/"/g, '') + "\"\n\t\t\"date\"\t\t\"" + date + "\"\n\t\t\"addr\"\t\t\"" + server[0].ip + ':' + server[0].port + "\"\n\t}\n";
			});
			
			file += "}";
			
			require('fs').writeFile(filename, file);
			alert("Blacklist has been saved. Import it from within the TF2 server browser using the \"Import Servers From File\" button on the \"Blacklisted Servers\" tab.");
			win.close();
		}, false);
		
		chooser.disabled = false;
		chooser.click();
	};
}