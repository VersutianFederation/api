var admin = require("firebase-admin");
var express = require("express");
var request = require("request");
var cors = require("cors");
var cookieParser = require('cookie-parser');
var schedule = require('node-schedule');
var jsonfile = require('jsonfile');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

var app = express();
var port = 3000;
var hostname = '127.0.0.1';

var serviceAccount = require("/opt/firebase/key.json");
var lootAccounts = require("/opt/data/lootAccounts.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://versutianpolls.firebaseio.com"
});

// Map(string:nation, Map(string:key, string:value))
var nationCache = new Map();

// https://stackoverflow.com/a/37510735
function getPropertyValue(object, property) {
  return property
    .split('.') // split string based on
    .reduce(function(o, k) {
      return o && o[k]; // get inner property if `o` is defined else get `o` and return
    }, object); // set initial value as object
}

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
                        var element = dom.window.document.querySelector(requests[i].toUpperCase());
                        if (element) {
                          nationData.set(requests[i], element.textContent);
                        } else {
                          nationData.set(request[i], "");
                        }
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

app.use(cors({
  origin: /versutian\.site$/,
  credentials: true
}));
app.use(cookieParser());

var cookieOptions = {
  domain: '.versutian.site',
  maxAge: 3600000,
  httpOnly: true,
  secure: true
};

app.get('/auth/token', function(req, res) {
  var uid = req.query.nation;
  var check = req.query.code;
  if (uid && check) {
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
            console.log("Error creating token: ", error);
            res.status(403).send('0');
          });
        });
      } else {
        res.status(403).send('0');
      }
    });
  } else {
    res.status(400).send('0');
  }
});

app.get('/auth/state', function(req, res) {
  var token = req.query.token;
  if (token) {
    // verify legitimacy of token
    admin.auth().verifyIdToken(token).then(function(decodedToken) {
      res.cookie('token', token, cookieOptions).send('1');
    }).catch(function(error) {
      console.log('Error saving token: ', error);
      res.status(403).send('0');
    });
  } else {
    res.status(400).send('0');
  }
});

app.get('/auth/verify', function(req, res) {
  var token = req.cookies.token;
  if (token) {
    admin.auth().verifyIdToken(token).then(function(decodedToken) {
      res.send(decodedToken);
    }).catch(function(error) {
      console.log('Error verifying token: ', error);
      res.status(403).send('0');
    });
  } else {
    res.status(400).send('0');
  }
});

app.get('/auth/clear', function(req, res) {
  res.clearCookie('token', cookieOptions);
  res.send('1');
});

// Nations allowed to do administrative actions for wGuild
var wGuildOfficers = ['humantus', 'akohos'];

// Constants
var DAILY_RATE_CAP = 5;
var STARTING_POINTS = 2500;
var POINTS_FLOOR = 1;
var POINTS_CAP = 10000;

var WG_DATA_FILE = "/opt/data/wguild.json";

var wGuildNations = new Map();
var wGuildApplied = [];

jsonfile.readFile(WG_DATA_FILE, function(err, obj) {
  if (err) {
    console.log('Error reading WG data: ', err);
    process.exit(1);
  } else {
    // Load nation data entries from file
    Object.entries(obj).forEach(function (nation) {
      var name = nation[0];
      var data = nation[1];
      var nationData = new WGuildNationData(name);
      nationData.points = data.points;
      nationData.livePoints = data.livePoints;
      nationData.gain = data.gain;
      nationData.bonus = data.bonus;
      nationData.rate = data.rate;
      nationData.lootboxes = data.lootboxes;
      nationData.freeLootbox = data.freeLootbox;
      nationData.lootBoost = data.lootBoost;
      nationData.highestRank = data.highestRank;
      wGuildNations.set(name, nationData);
    });
  }
});

// Item inventory data
function WGuildItemData(name, type, rewardCallback) {
  this.name = name; // Display name of the item
  this.type = type; // Equip slot or type for non cosmetics
  this.rewardCallback = rewardCallback; // For rewarding WGP or adding it to player's inventory
}

// Item economy data
function WGuildBoxDropData(item, box, tier, special) {
  this.item = item;
  this.box = box;
  this.tier = tier;
  this.special = special;
}

// Lootbox data
function WGuildBoxData(name) {
  this.name = name;
  this.cost = 100;
  this.odds = [0.65, 0.85, 0.95, 0.98]; // Odds array, must match 
  this.contents = new Map();
  this.tiers = ['Common', 'Uncommon', 'Rare', 'Elite', 'Ambassador Select'];
  this.refreshTiers = function() {
    // Fill the map
    this.tiers.forEach(function(value) {
      this.contents.set(value, []);
    });
  }
  this.addContents = function(tier, item) {
    if (typeof(tier) === "number") {
      tier = tiers[tier];
    }
    this.contents.get(tier).push(item);
  }
  this.open = function(nation) {
    nation.openLootbox(cost);
    return roll(nation);
  }
  this.roll = function(nation) {
    // Roll the numbers
    var tierRoll = Math.random(); // what tier 
    var odds = this.odds.slice(0); // odds
    if (nation.lootBoost) {
      // Odds are boosted, expand non-common tier chance by 5%
      odds.forEach(function(item, index) {
        odds[index] -= (0.05 * (odds.length - index));
      });
      // We've consumed this boost
      nation.lootBoost = false;
    }
    var tier; // loot tier
    var items; // possible items in tier
    tiers.forEach(function(value, index) {
      if (tierRoll <= odds[index] || index === odds.length) {
        tier = index + 1;
        return;
      }
    });
    items = contents.get(tiers[tier - 1]);
    var item = items[Math.floor(Math.random() * items.length)]; // what item in the tier
    nation.lootBoost = Math.random() <= 0.01; // if special
    // Notify admin Discord
    request({
        method: 'POST',
        uri: lootAccounts.announce.admin,
        json: true,
        body: {content: nation.name + ' received ' + (nation.lootBoost ? 'Special ' : '') + item}
    },
    function(err, response, body) {
      // Do not spoil drops in announcements
      setTimeout(function() {
        // Announce special and/or exceedingly rare items
        if (tier > 3 || nation.lootBoost) {
          // Get friendly name and flag image
          nsNation(member, ['name', 'flag'], function(data) {
            var nationName = data.get('name');
            var flagImg = data.get('flag');
            // Send to TVF Discord
            request({
                method: 'POST',
                uri: lootAccounts.announce.global,
                json: true, 
                body: {
                  content: '**' + nationName + '** just received an exceedingly rare drop: _' + (special ? 'Special ' : '') + item + '_!!!',
                  avatar_url: flagImg
                }
            });
          });
        }
      }, 10000);
      return new WGuildBoxDropData(item, this, tier, nation.lootBoost);
    });
  }
}

// Lootboxes
var firstBox = new WGuildBoxData("Lootbox Prime");
firstBox.refreshTiers();
firstBox.addContents(0, ['115 WGP', 'Gray Background', 'Lime Background', 'Brown Background']);
firstBox.addContents(1, ['Baseball Cap', 'Slate Gradient', 'Purple Background', 'Pink Background', 'Cyan Background', '1000 Stamps', '200 WGP']);
firstBox.addContents(2, ['Versutian Gradient Background', 'Top Hat', 'Soot Showers Effect', '500 WGP']);
firstBox.addContents(3, ['Flag Wave', 'Rainbow Gradient Background', 'Ray of Hope Effect', "Man's Not Hot Sound", '630 WGP', '2500 Stamps']);
firstBox.addContents(4, ['Pulsing Versutian Gradient Background', 'Crown', "Mom's Spaghetti Sound", 'Firey Passion Effect', '5000 Stamps', '1000 WGP']);
var winterLoot2017T1 = new WGuildBoxData("Winter 2017 Loot Tier I");
winterLoot2017T1.tiers = ["Frosty", "Festive", "Merry", "Jolly", "Miracle"];
winterLoot2017T1.refreshTiers();
var winterLoot2017T2 = new WGuildBoxData("Winter 2017 Loot Tier II");
winterLoot2017T2.tiers = ["Frosty", "Festive", "Merry", "Jolly", "Miracle"]
winterLoot2017T2.refreshTiers();
var winterLoot2017T3 = new WGuildBoxData("Winter 2017 Loot Tier III");
winterLoot2017T3.tiers = ["Frosty", "Festive", "Merry", "Jolly", "Miracle"]
winterLoot2017T3.refreshTiers();

// Nation data for wGuild
function WGuildNationData(name) {
  this.name = name; // Name of nation
  this.points = STARTING_POINTS; // Monthly rank (excludes gain)
  this.livePoints = STARTING_POINTS; // Live updating rank (includes gain)
  this.gain = 0; // Base points earned monthly
  this.bonus = 0; // Additional bonus points
  this.rate = DAILY_RATE_CAP; // Daily rate
  this.rateCap = DAILY_RATE_CAP; // Daily rate cap
  this.lootBoost = false; // Loot drop boost from special item
  this.highestRank = 2; // Highest rank achieved by this nation
  this.inventory = [];
  this.storage = [];
  this.equipment = new WGuildEquipment();
  // The current wGuild rank
  this.getRank = function() {
    return Math.floor(this.points / 1000);
  };
  // Run every month to award lootboxes and update monthly rank
  this.updatePoints = function() {
    // Reward 1 lootbox per 250 points earned
    var totalGain = this.gain + this.bonus;
    if (totalGain > 0) {
      this.lootboxes += Math.floor(totalGain / 250);
    }
    // Track change in rank
    var oldRank = this.getRank();
    // Add net points gain to monthly rank
    this.points += totalGain;
    // Cap points
    if (this.points > POINTS_CAP) {
      this.points = POINTS_CAP;
    } else if (this.points < POINTS_FLOOR) {
      this.points = POINTS_FLOOR;
    }
    // Reset monthly stats
    this.gain = 0;
    this.bonus = 0;
    this.rate = DAILY_RATE_CAP;
    // Get new rank
    var rank = this.getRank();
    // Rank changed
    if (oldRank !== rank) {
      if (rank > this.highestRank) {
        this.highestRank = rank;
        return 2; // achieved a new higher rank (notify all) 
      } else if (rank === 1) {
        return 2; // got demoted (notify all)
      } else {
        return 1; // changed rank (notify officers)
      }
    }
    return 0; // did not achieve a new rank
  };
  // Award points to the monthly gain for wGuild actions
  this.addPoints = function(add) {
    // Add to gain
    this.gain += add;
    // Calculate bonus points for positive gains
    if (this.gain > 0) {
      this.bonus = Math.round(this.gain * (((this.gain / 1000) / Math.sqrt((this.gain / 1000) + Math.pow(this.gain / 1000, 2)))));
    } else {
      this.bonus = 0;
    }
    // Update live points
    this.livePoints = this.points + this.gain + this.bonus;
    // Cap points
    if (this.livePoints > POINTS_CAP) {
      this.livePoints = POINTS_CAP;
    } else if (this.livePoints < POINTS_FLOOR) {
      this.livePoints = POINTS_FLOOR;
    }
  };
  // Refresh daily rate from certain wGuild actions
  this.bumpRate = function() {
    // Give daily rate according to current rate
    this.rate = Math.max(1, this.rate) * 2;
    // Cap daily rate
    if (this.rate > this.rateCap) {
      this.rate = this.rateCap;
    }
  };
  // Apply and decay daily rate at the start of each day
  this.updateRate = function() {
    // Apply daily rate
    this.addPoints(this.rate);
    // Decrease the rate by 1, to a minimum of 0
    if (this.rate > 0) {
      this.rate--;
    }
  };
  // Open a lootbox if there are any
  this.openLootbox = function(cost) {
    this.points -= cost;
    this.livePoints -= cost;
  };
}

function WGuildEquipment() {
  this.sound = {};
  this.background = {};
  this.glow = {};
  this.hat = {};
  this.flag = {};
  this.overlay = {};
}

app.get('/wg/points/add', function(req, res) {
  var nation = req.query.nation; // Nation getting added
  var token = req.cookies.token; // JWT
  // are they authed and did they specify a valid nation
  if (nation && token && wGuildNations.has(nation)) {
    // decode their JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      var uid = user.uid; // username
      // are they authorized to add WGP to nations?
      if (wGuildOfficers.includes(uid)) {
        var member = wGuildNations.get(nation);
        // how many instances of the reward type are we applying?
        var count = req.query.count;
        // if they didn't specify, default to 1
        var adding = true;
        if (!count) {
          count = 1;
          adding = true
        } else {
          count = parseInt(count, 10);
          adding = count !== 0;
        }
        if (adding) {
          var type = req.query.type; // type of reward
          // specifying the type is required
          if (type) {
            // refresh the daily WGP on applicable types
            if (count > 0 && (type === "welcome" || type === "standard")) {
              member.bumpRate();
            }
            // determine how much WGP we should add
            var add = 0;
            switch (type) {
              case "custom": // Custom WGP add
                add = count;
                break;
              case "standard": // Manual/Standard telegrams
                add = 3 * count;
                break;
              case "mass": // Mass Telegram per 100 stamps
                add = 4 * count;
                break;
              case "api": // Recruitment API per 1 hour
                add = 2 * count;
                break;
              case "welcome": // Manual welcome telegram
                add = 5 * count;
                break;
              case "join": // Referral
                add = 8 * count;
                break;
              case "citizen": // Citizen approval
                add = 12 * count;
                break;
              case "discord": // Discord referral
                add = 14 * count;
                break;
              case "roleplayer": // Roleplay referral
                add = 25 * count;
                break;
              case "vote": // Participation in election vote
                add = 35 * count;
                break;
              case "candidate": // Participation in election race
                add = 50 * count;
                break;
              case "fail": // Improper onboarding process
                add = -30 * count;
                break;
              case "abuse": // Abuse of privileges
                add = -2000 * count;
                break;
              default:
                break;
            }
            if (add === 0) {
              // did not specify type
              res.status(400).send('0');
            } else {
              // Add the points accordingly
              member.addPoints(add);
              res.send('1');
            }
          }
        }
      } else {
        res.status(403).send('0');
      }
    }).catch(function(error) {
      console.log("Error verifying token: ", error);
      res.status(403).send('0');
    });
  } else {
    res.status(400).send('0');
  }
});

app.get('/wg/points/get', function(req, res) {
  res.json(leaderboard);
});

app.get('/wg/member/add', function(req, res) {
  var nation = req.query.nation; // Nation getting added
  var token = req.cookies.token; // JWT
  // are they authed and did they specify an non-existent nation
  if (nation && token && !wGuildNations.has(nation)) {
    // decode their JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      var uid = user.uid; // username
      // are they authorized to add accounts 
      if (wGuildOfficers.includes(uid)) {
        // remove from applied list
        if (wGuildApplied.includes(nation)) {
          wGuildApplied.splice(wGuildApplied.indexOf(nation), 1) ;
        }
        wGuildNations.set(nation, new WGuildNationData(nation));
        res.status(202).send('1');
        // Announce a new member!
        nsNation(nation, ['name', 'flag'], function(data) {
          // Get friendly name and flag URL
          var nationName = data.get('name');
          var flagImg = data.get('flag');
          // Send to TVF Discord
          request({
              method: 'POST',
              uri: lootAccounts.announce.global,
              json: true, 
              body: {
                content: '**' + nationName + "** just joined the Welcomers' Guild!",
                avatar_url: flagImg
              }
          });
        });
      } else {
        res.status(403).send('0');
      }
    }).catch(function(error) {
      console.log("Error verifying token: ", error);
      res.status(403).send('0');
    });
  } else {
    res.status(400).send('0');
  }
});

app.get('/wg/member/apply', function(req, res){ 
  var token = req.cookies.token; // JWT
  // are they authed
  if (token) {
    // verify JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      var member = user.uid;
      // are they a member and haven't applied already
      if (!wGuildNations.has(member) && !wGuildApplied.includes(member)) {
        request({
          method: 'POST',
          uri: lootAccounts.announce.admin,
          json: true,
          body: {content: member + ' wants to join. https:// api.versutian.site /wg/member/add?nation=' + member}
        },
        function(err, response, body) {
          if (err) {
            res.status(500).send('0');
          } else {
            res.send('1');
          }
        });
      } else {
        res.status(403).send('0');
      }
    }).catch(function(error) {
      console.log("Error verifying token: ", error);
      res.status(403).send('0');
    });
  } else {
    res.status(400).send('0');
  }
});

app.get('/wg/member/status', function(req, res) {
  var token = req.cookies.token; // JWT
  // are they authed
  if (token) {
    // verify JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      var member = user.uid;
      if (wGuildNations.has(member)) {
        // are they a member
        res.send('3');
      } else if (wGuildApplied.includes(member)) {
        // they've already applied
        res.send('2');
      } else {
        // they have not applied
        res.send('1');
      }
    }).catch(function(error) {
      console.log("Error verifying token: ", error);
      res.status(403).send('0');
    });
  } else {
    res.status(400).send('0');
  }
});

app.get('/wg/loot/roll', function(req, res) {
  var token = req.cookies.token; // JWT
  // are they authed
  if (token) {
    // verify JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      var member = user.uid;
      // are they a member
      if (wGuildNations.has(member)) {
        var nation = wGuildNations.get(member);
        // if they have a lootbox, open it
        if (nation.openLootbox()) {

        } else {
          res.status(403).send('0');
        }
      } else {
        res.status(403).send('0');  
      }
    }).catch(function(error) {
      console.log("Error verifying token: ", error);
      res.status(403).send('0');
    });
  } else {
    res.status(400).send('0');
  }
});

/* TODO
app.get('/wg/loot/equip', function(req, res) {
  var item = req.query.item;
  var nation = req.query.nation;
  if (item && nation) {
      request({method: 'POST', uri: lootkeys.ping, json: true, body: {content: nation + ' equipped ' + item}}, function(err, response, body) {
         if (err) {
           res.send('0');
         } else {
           res.send('1');
         }
      });
  } else {
    res.send('0');
  }
});
*/

app.get('/wg/loot/inventory', function(req, res) {
  var token = req.cookies.token; // JWT
  // are they authed
  if (token) {
    // verify JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      // are they a member?
      if (wGuildNations.has(user.uid)) {
        var nation = wGuildNations.get(user.uid);
        // give inventory info
        res.send({
          count: nation.lootboxes,
          special: nation.lootBoost
        });
      } else {
        res.status(403).send('0');
      }
    }).catch(function(error) {
      console.log("Error verifying token: ", error);
      res.status(403).send('0');
    });
  } else {
    res.status(400).send('0');
  }
});

app.get('/admin/save', function (req, res) {
  var token = req.cookies.token; // JWT
  // are they authed
  if (token) {
    // decode their JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      var uid = user.uid; // username
      // are they authorized to save
      if (wGuildOfficers.includes(uid)) {
        save();
        res.status(202).send('1');
      } else {
        res.status(403).send('0');
      }
    }).catch(function(error) {
      console.log("Error verifying token: ", error);
      res.status(403).send('0');
    });
  } else {
    res.status(400).send('0');
  }
});

app.get('/admin/daily', function(req, res) {
  var token = req.cookies.token; // JWT
  // are they authed
  if (token) {
    // decode their JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      var uid = user.uid; // username
      // are they authorized to save
      if (wGuildOfficers.includes(uid)) {
        updateDaily();
        res.status(202).send('1');
      } else {
        res.status(403).send('0');
      }
    }).catch(function(error) {
      console.log("Error verifying token: ", error);
      res.status(403).send('0');
    });
  } else {
    res.status(400).send('0');
  }
});

app.get('/admin/monthly', function(req, res) {
  var token = req.cookies.token; // JWT
  // are they authed
  if (token) {
    // decode their JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      var uid = user.uid; // username
      // are they authorized to save
      if (wGuildOfficers.includes(uid)) {
        updateMonthly();
        res.status(202).send('1');
      } else {
        res.status(403).send('0');
      }
    }).catch(function(error) {
      console.log("Error verifying token: ", error);
      res.status(403).send('0');
    });
  } else {
    res.status(400).send('0');
  }
});

app.listen(port, hostname);

var db = {};
var leaderboard = {};

function save() {
  db = {};
  var a = [];
  for (var nation of wGuildNations.values()) {
    a.push(nation);
  }
  a.sort(function(a, b) {
    return b.livePoints - a.livePoints;
  });
  wGuildNations = new Map();
  for (var nation of a) {
    wGuildNations.set(nation.name, nation);
  }
  wGuildNations.forEach(function (member, name) {
    nsNation(name, ['flag', 'name'], function(data) {
      // collect properties
      Object.defineProperty(db, name, {
        configurable: true,
        writable: true,
        enumerable: true,
        value: {
          points: member.points,
          livePoints: member.livePoints,
          gain: member.gain,
          bonus: member.bonus,
          rate: member.rate,
          lootboxes: member.lootboxes,
          freeLootbox: member.freeLootbox,
          lootBoost: member.lootAccounts,
          highestRank: member.highestRank
        }
      });
      Object.defineProperty(leaderboard, name, {
        configurable: true,
        writable: true,
        enumerable: true,
        value: {
          points: member.points,
          livePoints: member.livePoints,
          gain: member.gain,
          bonus: member.bonus,
          rate: member.rate,
          equipment: member.equipment,
          highestRank: member.highestRank,
          displayName: data.get('name'),
          flagImg: data.get('flag')
        }
      });
    });
  });
  // save data
  jsonfile.writeFile(WG_DATA_FILE, db, function(err) {
    if (err) {
      console.log('Failed saving data: ', err)
    }
  });
}

save();
save();

// Update Daily Rate for all members
function updateDaily() {
  wGuildNations.forEach(function (member, name) {
    member.updateRate(); // update daily rate
  });
}

// Bump points for all members
function updateMonthly() {
  wGuildNations.forEach(function (member) {
    member.updatePoints();
  });
}

// Run hourly, but 1 minute after daily update
var hourly = schedule.scheduleJob('2 * * * *', function() {
  save();
});

// Run at midnight, but 1 minute after monthly update
var daily = schedule.scheduleJob('1 0 * * *', function() {
  updateDaily();
});

// Run monthly at midnight
var monthly = schedule.scheduleJob('0 0 1 * *', function() {
  updateMonthly();
});
