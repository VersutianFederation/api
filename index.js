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

// List of items. key is item id.
var items = new Map();

var itemSpaceMatcher = / /g;
var itemCharacterMatcher = /^[a-zA-Z0-9_]+$/;

// Item inventory data
function WGuildItem(name, type, extra) {
  this.extra = extra;
  this.name = name; // Display name of the item
  if (type === "points") {
    this.name = this.extra + " WGP";
  }
  this.id = name.replace(itemSpaceMatcher, "_").replace(itemCharacterMatcher, "").toLowerCase();
  this.type = type; // Equip slot or type for non cosmetics
  this.rewardCallback = function() {}; // For rewarding WGP or adding it to player's inventory
  if (type.startsWith("cosmetic")) {
    this.rewardCallback = function(nation, drop) {
      nation.inventory.push(drop)
    }
  } else if (type === "lootbox") {
      nation.storage.push(drop);
  } else if (type === "points") {
    this.rewardCallback = function(nation) {
      nation.addPoints(this.extra);
    }
  }
  this.addItem = function() {
    items.set(this.id, this);
  }
  this.addItem();
}

// Items
// Points
var pointsLow = new WGuildItem("WGP", "points", 115);
var pointsMedium = new WGuildItem("WGP", "points", 200);
var pointsHigh = new WGuildItem("WGP", "points", 500);
var pointsHigher = new WGuildItem("WGP", "points", 630);
var pointsHighest = new WGuildItem("WGP", "points", 1000);
var pointsHigherest = new WGuildItem("WGP", "points", 5000);

// Stamps
var stampsLow = new WGuildItem("1000 Stamps", "stamps");
var stampsMedium = new WGuildItem("2500 Stamps", "stamps");
var stampsHigh = new WGuildItem("5000 Stamps", "stamps");

// Sounds
var mansNotHot = new WGuildItem("Man's Not Hot Sound", "cosmetic.sound");
var momsSpaghetti = new WGuildItem("Mom's Spaghetti Sound", "cosmetic.sound");

// Backgrounds
var backgroundGray = new WGuildItem("Gray Background", "cosmetic.background");
var backgroundLime = new WGuildItem("Lime Background", "cosmetic.background");
var backgroundBrown = new WGuildItem("Brown Background", "cosmetic.background");
var backgroundSlate = new WGuildItem("Slate Gradient", "cosmetic.background");
var backgroundPurple = new WGuildItem("Purple Background", "cosmetic.background");
var backgroundPink = new WGuildItem("Pink Background", "cosmetic.background");
var backgroundCyan = new WGuildItem("Cyan Background", "cosmetic.background");
var backgroundVersutia = new WGuildItem("Versutian Gradient Background", "cosmetic.background");
var backgroundRainbow = new WGuildItem("Rainbow Gradient Background", "cosmetic.background");
var backgroundVersutiaPulse = new WGuildItem("Pulsing Versutian Gradient Background");

// Effects
var effectSoot = new WGuildItem("Soot Showers Effect", "cosmetic.effect");
var effectRay = new WGuildItem("Ray of Hope Effect", "cosmetic.effect");
var effectHeart = new WGuildItem("Firey Passion Effect", "cosmetic.effect");

// Flags
var flagWave = new WGuildItem("Flag Wave", "cosmetic.flag");

// Hats
var hatBaseball = new WGuildItem("Baseball Cap", "cosmetic.hat");
var hatTopHat = new WGuildItem("Top Hat", "cosmetic.hat");
var hatCrown = new WGuildItem("Crown", "cosmetic.hat");

// Skins
var winterWonderland = new WGuildItem("Winter Wonderland 2017", "cosmetic.skin");

// Glows
var specialGlow = new WGuildItem("Gilded Glow", "cosmetic.glow");

function WGuildBoxDropData(item, box, tier, special) {
  this.item = item;
  this.box = box;
  this.tier = tier;
  this.special = special;
}

var lootboxes = new Map();

// Lootbox data
function WGuildBoxData(name) {
  this.name = name;
  this.id = name.replace(itemSpaceMatcher, "_").replace(itemCharacterMatcher, "").toLowerCase();
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
      tier = this.tiers[tier];
    }
    if (Array.isArray(item)) {
      Array.prototype.push.apply(this.contents.get(tier), item)
    } else {
      this.contents.get(tier).push(item);
    }
  }
  this.open = function(nation) {
    nation.openLootbox(this.cost);
    return this.roll(nation);
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
    var loot; // possible items in tier
    this.tiers.forEach(function(value, index) {
      if (index === odds.length || tierRoll <= odds[index]) {
        tier = index + 1;
        return;
      }
    });
    loot = this.contents.get(this.tiers[tier - 1]);
    var item = loot[Math.floor(Math.random() * loot.length)]; // what item in the tier
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
  this.addItem = function() {
    lootboxes.set(this.id, this);
  }
  this.addItem();
}

// Lootboxes
var firstBox = new WGuildBoxData("Lootbox Prime");
firstBox.refreshTiers();
firstBox.addContents(0, [pointsLow, backgroundGray, backgroundLime, backgroundBrown]);
firstBox.addContents(1, [hatBaseball, backgroundSlate, backgroundPurple, backgroundPink, backgroundCyan, stampsLow, pointsMedium]);
firstBox.addContents(2, [backgroundVersutia, hatTopHat, effectSoot, pointsHigh]);
firstBox.addContents(3, [flagWave, backgroundRainbow, effectRay, mansNotHot, pointsHigher, stampsMedium]);
firstBox.addContents(4, [backgroundVersutiaPulse, hatCrown, momsSpaghetti, effectHeart, stampsHigh, pointsHighest]);
var firstFreeBox = new WGuildBoxData("Lootbox Prime (Free)");
firstFreeBox.cost = 0;
firstFreeBox.refreshTiers();
firstFreeBox.addContents(0, [pointsLow, backgroundGray, backgroundLime, backgroundBrown]);
firstFreeBox.addContents(1, [hatBaseball, backgroundSlate, backgroundPurple, backgroundPink, backgroundCyan, stampsLow, pointsMedium]);
firstFreeBox.addContents(2, [backgroundVersutia, hatTopHat, effectSoot, pointsHigh]);
firstFreeBox.addContents(3, [flagWave, backgroundRainbow, effectRay, mansNotHot, pointsHigher, stampsMedium]);
firstFreeBox.addContents(4, [backgroundVersutiaPulse, hatCrown, momsSpaghetti, effectHeart, stampsHigh, pointsHighest]);
var winterLoot2017T1 = new WGuildBoxData("Winter 2017 Gift Box");
winterLoot2017T1.tiers = ["Frosty", "Festive", "Merry", "Jolly", "Miracle"];
winterLoot2017T1.cost = 0;
winterLoot2017T1.refreshTiers();
var winterLoot2017T2 = new WGuildBoxData("Winter 2017 Gift Stocking");
winterLoot2017T2.cost = 0;
winterLoot2017T2.tiers = ["Frosty", "Festive", "Merry", "Jolly", "Miracle"]
winterLoot2017T2.refreshTiers();
var winterLoot2017T3 = new WGuildBoxData("Winter 2017 Gift Sack");
winterLoot2017T3.cost = 0;
winterLoot2017T3.tiers = ["Frosty", "Festive", "Merry", "Jolly", "Miracle"]
winterLoot2017T3.refreshTiers();
var ambassadorSelectLootbox = new WGuildBoxData("Ambassador Select Lootbox");
ambassadorSelectLootbox.tiers = ["Ambassador Select"];
ambassadorSelectLootbox.odds = [];
ambassadorSelectLootbox.refreshTiers();
ambassadorSelectLootbox.addContents(0, [backgroundVersutiaPulse, hatCrown, momsSpaghetti, effectHeart, stampsHigh, pointsHighest]);
var winterWheel2017 = new WGuildBoxData("Winter Wheel of Random Rewards");
winterWheel2017.tiers = ['Common', 'Uncommon', 'Rare', 'Very Rare', 'Ultra Rare', 'Inconceivably Rare'];
winterWheel2017.odds = [0.7, 0.9, 0.974, 0.994, 0.999];
winterWheel2017.refreshTiers();
winterWheel2017.addContents(0, [backgroundGray, backgroundSlate, backgroundBrown]);
winterWheel2017.addContents(1, firstBox);
winterWheel2017.addContents(2, [pointsLow, pointsMedium, pointsHigh]);
winterWheel2017.addContents(3, stampsMedium);
winterWheel2017.addContents(4, ambassadorSelectLootbox);

// Nation data for wGuild
function WGuildNationData(name) {
  this.name = name; // Name of nation
  this.points = STARTING_POINTS; // Monthly rank (excludes gain)
  this.livePoints = STARTING_POINTS; // Live updating rank (includes gain)
  this.gain = 0; // Base points earned monthly
  this.bonus = 0; // Additional bonus points
  this.rate = DAILY_RATE_CAP; // Daily rate
  this.rateCap = DAILY_RATE_CAP; // User specific daily rate cap
  this.lootBoost = false; // Loot drop boost from special item
  this.highestRank = 2; // Highest rank achieved by this nation
  this.inventory = []; // Array of item IDs in inventory
  this.storage = []; // Array of lootbox IDs in storage
  this.equipment = new WGuildEquipment(); // Object of inventory indices
  this.duels = new Map(); // Dueling nations
  this.pass = null; // Pass
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
  this.openLootbox = function(cost) {
    this.points -= cost;
    this.livePoints -= cost;
  };
  this.equipItem = function(id) {
    var slot = items.get(inventory[id]).type.split(".")[1];
    switch (slot) {
      case "sound":
          this.equipment.sound = id;
        break;
      case "background":
          this.equipment.background = id;
        break;
      case "effect":
        this.equipment.effect = id;
        break;
      case "flag":
        this.equipment.flag = id;
        break;
      case "hat":
        this.equipment.hat = id;
        break;
      case "glow":
        this.equipment.glow = id;
        break;
      case "skin":
        this.equipment.skin = id;
      default:
        break;
    }
  }
  this.unequipSlot = function(slot) {
    switch (slot) {
      case "sound":
          this.equipment.sound = -1;
        break;
      case "background":
          this.equipment.background = -1;
        break;
      case "effect":
        this.equipment.effect = -1;
        break;
      case "flag":
        this.equipment.flag = -1;
        break;
      case "hat":
        this.equipment.hat = -1;
        break;
      case "glow":
        this.equipment.glow = -1;
        break;
      case "skin":
        this.equipment.skin = -1;livePoints
      default:
        break;
    }
  }
  this.startDuel = function(nation) {
    this.duels.set(nation, nation.livePoints)
    nation.duels.set(this, this.livePoints);
  }
  this.endDuel = function(nation) {
    var enemyGain = nation.livePoints - this.duels.get(nation);
    var selfGain = this.livePoints - nation.duels.get(this);
    if (enemyGain === selfGain) {
      // tie
    } else if (selfGain > enemyGain) {
      // win
    } else {
      // lose
    }
  }
}

// Index in inventory
function WGuildEquipment() {
  this.sound = -1;
  this.background = -1;
  this.effect = -1;
  this.flag = -1;
  this.hat = -1;
  this.glow = -1;
  this.skin = -1;
}

function GuildPass(nation) {
  this.nation = nation;
  this.duelTokens = 1;
  this.weeklyDuelTokens = 1;
  this.refreshDuels = function() {

  }
}

function QuestPath() {
  this.name = name;
  
}

function Quest(name, description) {
  this.name = name;
  this.description = description;
  this.completed = false;
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

app.get('/wg/member/list', function(req, res) {
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
          body: {content: member + ' wants to join. https:// api.versu tian.site/wg/member/add?nation=' + member}
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
  var index = req.query.index; // Storage index
  // are they authed
  if (token && index && index > 0) {
    // verify JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      var member = user.uid;
      // are they a member
      if (wGuildNations.has(member)) {
        var nation = wGuildNations.get(member);
        if (index < nation.storage.length) {
          var drop = lootboxes.get(nation.storage[index]).open(nation);
          drop.item.rewardCallback(nation, drop);
          res.json({
            rarity: drop.box.tiers[drop.tier - 1],
            special: drop.special,
            name: drop.item.name,
            id: drop.item.id
          });
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

app.get('/wg/loot/equip', function(req, res) {
  var token = req.cookies.token; // JWT
  // are they authed
  if (token) {
    // verify JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      // are they a member?
      if (wGuildNations.has(user.uid)) {
        var nation = wGuildNations.get(user.uid);
        if (!index || index < -1 || index >= nation.inventory.length) {
          index = -1;
        }
        nation.equipItem(index);
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

// TODO: use actual inventory
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

// TODO: quests

// TODO: duels

// TODO: winter wheel

app.listen(port, hostname);

// TODO: serialize new data
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
      // save data
      jsonfile.writeFile(WG_DATA_FILE, db, function(err) {
        if (err) {
          console.log('Failed saving data: ', err)
        }
      });
    });
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
