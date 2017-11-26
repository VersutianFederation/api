var admin = require("firebase-admin");
var express = require("express");
var request = require("request");
var cors = require("cors");
var text = require("textbelt");
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

var app = express();
var port = 3000;
var hostname = '127.0.0.1';

var serviceAccount = require("/opt/firebase/key.json");
var lootkeys = require("/opt/firebase/lootkeys.json");

// Map(string:nation, Map(string:key, string:value))
var nationCache = new Map();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://versutianpolls.firebaseio.com"
});

app.use(cors());
app.listen(port, hostname);

/*
function requestApiSafe(url, callback, xml) {
        request(url, function(reqe, reqr, reqb) 
            // check if we are on NS API cooldown
            if (url.startsWith('https://www.nationstates.net/cgi-bin/api.cgi?nation=')) {
                // notify the user that they're on API cooldown
                if (xhr.status === 429) {
                    // notify the user once
                    return;
                } else {
                    // reset ban notification tracker
                    nsBan = false;
                }
            }
            // give our callback XML if it requested it
            callback();
        };
        xhr.open("GET", url);
        xhr.send();
}
*/

function nsNation(nation, data, callback) {
        // check if we have a cache entry for this nation at all
        if (!nationCache.has(nation)) {
            nationCache.set(nation, new Map());
        }
        // get the cache map for this nation
        var nationData = nationCache.get(nation);
        // check data that has been cached and skip getting it from the API
        var requestString = "";
        var requests = [];
        for (var i = 0; i < data.length; i++) {
            if (!nationData.has(data[i]) || nationData.get(data[i]).length === 0) {
                requests.push(data[i]);
                if (requestString.length === 0) {
                    requestString = data[i];
                } else {
                    requestString += "+" + data[i];
                }
            }
        }
        // check if we have data to get from the API
        if (requestString.length !== 0) {
            // request the data
            var options = {
              url: "https://www.nationstates.net/cgi-bin/api.cgi?nation=" + nation + "&q=" + requestString,
              headers: {
                "User-Agent": "Versutian Web Service by Humantus"
              }
            };
            request(options, function(nationErr, nationH, nationRes) {
                dom = new JSDOM(nationRes);
                for (var i = 0; i < requests.length; i++) {
                    // check if we got data from the API
                    if (nationRes === null) {
                        // blank data since callbacks expect non-null
                        nationData.set(request[i], "");
                    } else {
                        // cache data we got from the API
                        nationData.set(requests[i], dom.window.document.querySelector(requests[i].toUpperCase()).textContent);
                    }
                }
                // give freshly cached data to the callback
                callback(nationData);
            });
        } else {
            // give cached data to the callback
            callback(nationData);
        }
}

app.get('/token', function(req, res) {
  var check = req.query.token;
  var uid = req.query.nation;
  if (check && uid) {
    var options = {
       url: 'https://www.nationstates.net/cgi-bin/api.cgi?a=verify&nation=' + uid + '&checksum=' + check,
       headers: {
         'User-Agent': 'Versutian Web Service by Humantus'
       }
    }
    request(options, function(reqe, reqr, reqb) {
      if (reqb && reqb.includes('1')) {
        nsNation(uid, ['flag', 'name'], function(data) {
         var claims = {
            nation: data.get('name'),
            flag: data.get('flag')
          };
          admin.auth().createCustomToken(uid, claims).then(function(token) {
            res.send(token);
          }).catch(function(error) {
            console.log("Error creating token:", error);
          });
        });        
      } else {
        res.send('0');
      }
    });
  } else {
    res.send('0');
  }
});

function hasSpecial(nation) {
  return boostMap.has(nation) && boostMap.get(nation);
}

var lootMap = new Map();
var boostMap = new Map();

var rewardOfVirtue = true;

app.get('/loot', function(req, res) {
  var nation = req.query.nation;
  var key = req.query.key;
  if (key === lootkeys.super_secret) {
     var add = parseInt(req.query.add, 10);
     if (add) {
       if (lootMap.has(nation)) {
         lootMap.set(nation, lootMap.get(nation) + add);
       } else {
         lootMap.set(nation, add);
       }
     }
  } else {
    if (lootMap.has(nation) && lootMap.get(nation) > 0) {
      lootMap.set(nation, lootMap.get(nation) - 1);
      var tierRoll = Math.random();
      var specialRoll = Math.random();
      var itemRoll = Math.random();
      var tier;
      var special = specialRoll <= 0.01;
      var items;
      var odds = [0.65, 0.85, 0.95, 0.98];
      if (hasSpecial(nation)) {
        odds.forEach(function(item, index) {
          odds[0] -= 0.05;
          odds[index] -= 0.05;
        });
        boostMap.set(nation, false);
      }
      if (tierRoll <= odds[0]) {
        tier = 1; // Common
        items = ['115 RRP', 'Gray Background', 'Lime Background', 'Brown Background'];
      } else if (tierRoll <= odds[1]) {
        tier = 2; // Uncommon
        items = ['Baseball Cap', 'Slate Gradient', 'Purple Background', 'Pink Background', 'Cyan Background', '1000 Stamps', '200 RRP'];
      } else if (tierRoll <= odds[2]) {
        tier = 3; // Rare
        items = ['Versutian Gradient Background', 'Top Hat', 'Soot Showers Effect', '500 RRP'];
      } else if (tierRoll <= odds[3]) {
        tier = 4; // Elite
        items = ['Flag Wave', 'Rainbow Gradient Background', 'Ray of Hope Effect', "Man's Not Hot Sound", '630 RRP', '2500 Stamps'];
      } else {
        tier = 5; // Ambassador Select
        items = ['Pulsing Versutian Gradient Background', 'Crown', "Mom's Spaghetti Sound", 'Firey Passion Effect', '5000 Stamps', '1000 RRP'];
      }
      itemRoll *= items.length;
      var itemRoll = Math.floor(itemRoll);
      var item = items[itemRoll];
      if (special) {
        boostMap.set(nation, true);
      }
      if (rewardOfVirtue && nation === 'valturus') {
         rewardOfVirtue = false;
         item = 'Firey Passion Effect';
         tier = 5;
      }
      res.send({
        tier: tier,
        item: item,
        special: special
      });
      text.send(lootkeys.number, nation + ' received a ' + item, 'us', function(err) {
        if (err) {
          console.log(err);
        }
      });
    } else {
      res.send('0');
    }
  }
});

app.get('/equip', function(req, res) {
  var item = req.query.item;
  var nation = req.query.nation;
  text.send(lootkeys.number, nation + ' equipped a ' + item, 'us', function(err) {
    if (err) {
      console.log(err);
    }
  });
});

app.get('/boxes', function(req, res) {
  var nation = req.query.nation;
  var count = lootMap.has(nation) ? lootMap.get(nation) : 0;
  res.send({
    count: count,
    special: hasSpecial(nation)
  });
});
