import mongoose from 'mongoose';
import {
  model as User,
  nameFields,
} from './user';
import shared from '../../../common';
import _  from 'lodash';
import { model as Challenge} from './challenge';
import validator from 'validator';
import * as firebase from '../libs/api-v2/firebase';
import baseModel from '../libs/api-v3/baseModel';
import Q from 'q';

let Schema = mongoose.Schema;

// NOTE once Firebase is enabled any change to groups' members in MongoDB will have to be run through the API
// changes made directly to the db will cause Firebase to get out of sync
export let schema = new Schema({
  // TODO don't break validation on _id === 'habitrpg'
  name: {type: String, required: true},
  description: String,
  leader: {type: String, ref: 'User', validate: [validator.isUUID, 'Invalid uuid.'], required: true},
  type: {type: String, enum: ['guild', 'party'], required: true},
  privacy: {type: String, enum: ['private', 'public'], default: 'private', required: true},
  // _v: {type: Number,'default': 0}, // TODO ?
  chat: Array, // TODO ?
  /*
  #    [{
  #      timestamp: Date
  #      user: String
  #      text: String
  #      contributor: String
  #      uuid: String
  #      id: String
  #    }]
  */
  leaderOnly: { // restrict group actions to leader (members can't do them)
    challenges: {type: Boolean, default: false, required: true},
    // invites: {type:Boolean, 'default':false} // TODO ?
  },
  memberCount: {type: Number, default: 1},
  challengeCount: {type: Number, default: 0},
  balance: {type: Number, default: 0},
  logo: String,
  leaderMessage: String,
  quest: {
    key: String,
    active: {type: Boolean, default: false},
    leader: {type: String, ref: 'User'},
    progress: {
      hp: Number,
      collect: {type: Schema.Types.Mixed, default: () => {
        return {};
      }}, // {feather: 5, ingot: 3}
      rage: Number, // limit break / "energy stored in shell", for explosion-attacks
    },

    // Shows boolean for each party-member who has accepted the quest. Eg {UUID: true, UUID: false}. Once all users click
    // 'Accept', the quest begins. If a false user waits too long, probably a good sign to prod them or boot them.
    // TODO when booting user, remove from .joined and check again if we can now start the quest
    // TODO as long as quests are party only we can keep it here
    // TODO are we sure we need this type of default for this to work?
    members: {type: Schema.Types.Mixed, default: () => {
      return {};
    }},
    extra: {type: Schema.Types.Mixed, default: () => {
      return {};
    }},
  },
}, {
  strict: true,
  minimize: false, // So empty objects are returned
});

schema.plugin(baseModel, {
  noSet: ['_id', 'balance', 'quest', 'memberCount', 'chat', 'challengeCount'],
});

// A list of additional fields that cannot be updated (but can be set on creation)
let noUpdate = ['privacy', 'type'];
schema.statics.sanitizeUpdate = function sanitizeUpdate (updateObj) {
  return model.sanitize(updateObj, noUpdate); // eslint-disable-line no-use-before-define
};

// TODO migration
/**
 * Derby duplicated stuff. This is a temporary solution, once we're completely off derby we'll run an mongo migration
 * to remove duplicates, then take these fucntions out
 */
/* function removeDuplicates(doc){
  // Remove duplicate members
  if (doc.members) {
    var uniqMembers = _.uniq(doc.members);
    if (uniqMembers.length != doc.members.length) {
      doc.members = uniqMembers;
    }
  }
}*/

// TODO test
schema.pre('remove', true, async function preRemoveGroup (next, done) {
  next();
  let group = this;
  try {
    await group.removeGroupInvitations();
    done();
  } catch (err) {
    done(err);
  }
});

schema.post('remove', function postRemoveGroup (group) {
  firebase.deleteGroup(group._id);
});

schema.statics.getGroup = function getGroup (options = {}) {
  let {user, groupId, fields, optionalMembership = false, populateLeader = false} = options;
  let query;

  // When optionalMembership is true it's not required for the user to be a member of the group
  if (optionalMembership === true) {
    query = {_id: groupId};
  } else if (groupId === 'party' || user.party._id === groupId) {
    query = {type: 'party', _id: user.party._id};
  } else if (user.guilds.indexOf(groupId) !== -1) {
    query = {type: 'guild', _id: groupId};
  } else {
    query = {type: 'guild', privacy: 'public', _id: groupId};
  }

  let mQuery = this.findOne(query);
  if (fields) mQuery.select(fields);
  if (populateLeader === true) mQuery.populate('leader', nameFields);
  return mQuery.exec();
  // TODO purge chat flags info? in tojson?
};

schema.methods.removeGroupInvitations = async function removeGroupInvitations () {
  let group = this;

  let usersToRemoveInvitationsFrom = await User.find({
    // TODO id -> _id ?
    [`invitations.${group.type}${group.type === 'guild' ? 's' : ''}.id`]: group._id,
  }).exec();

  let userUpdates = usersToRemoveInvitationsFrom.map(user => {
    if (group.type === 'party') {
      user.invitations.party = {}; // TODO mark modified
    } else {
      let i = _.findIndex(user.invitations.guilds, {id: group._id});
      user.invitations.guilds.splice(i, 1);
    }
    return user.save();
  });

  return Q.all(userUpdates);
};

// Return true if user is a member of the group
schema.methods.isMember = function isGroupMember (user) {
  if (this._id === 'habitrpg') {
    return true; // everyone is considered part of the tavern
  } else if (this.type === 'party') {
    return user.party._id === this._id ? true : false;
  } else { // guilds
    return user.guilds.indexOf(this._id) !== -1;
  }
};

export function chatDefaults (msg, user) {
  let message = {
    id: shared.uuid(),
    text: msg,
    timestamp: Number(new Date()),
    likes: {},
    flags: {},
    flagCount: 0,
  };

  if (user) {
    _.defaults(message, {
      uuid: user._id,
      contributor: user.contributor && user.contributor.toObject(),
      backer: user.backer && user.backer.toObject(),
      user: user.profile.name,
    });
  } else {
    message.uuid = 'system';
  }

  return message;
}

schema.methods.sendChat = function sendChat (message, user) {
  this.chat.unshift(chatDefaults(message, user));
  this.chat.splice(200);

  // Kick off chat notifications in the background. // TODO refactor
  let lastSeenUpdate = {$set: {}, $inc: {_v: 1}}; // TODO standardize this _v inc at the user level
  lastSeenUpdate.$set[`newMessages.${this._id}`] = {name: this.name, value: true};

  if (this._id === 'habitrpg') {
    // TODO For Tavern, only notify them if their name was mentioned
    // var profileNames = [] // get usernames from regex of @xyz. how to handle space-delimited profile names?
    // User.update({'profile.name':{$in:profileNames}},lastSeenUpdate,{multi:true}).exec();
  } else {
    User.update({
      _id: {$in: this.members, $ne: user ? user._id : ''},
    }, lastSeenUpdate, {multi: true}).exec();
  }
};

function _cleanQuestProgress (merge) {
  // TODO clone? (also in sendChat message)
  let clean = {
    key: null,
    progress: {
      up: 0,
      down: 0,
      collect: {},
    },
    completed: null,
    RSVPNeeded: false, // TODO absolutely change this cryptic name
  };

  if (merge) { // TODO why does it do 2 merges?
    _.merge(clean, _.omit(merge, 'progress'));
    _.merge(clean.progress, merge.progress);
  }

  return clean;
}

schema.statics.cleanQuestProgress = _cleanQuestProgress;

// Participants: Grant rewards & achievements, finish quest
schema.methods.finishQuest = function finishQuest (quest) {
  let questK = quest.key;
  let updates = {$inc: {}, $set: {}};

  updates.$inc[`achievements.quests.${questK}`] = 1;
  updates.$inc['stats.gp'] = Number(quest.drop.gp); // TODO are this castings necessary?
  updates.$inc['stats.exp'] = Number(quest.drop.exp);
  updates.$inc._v = 1;

  if (this._id === 'habitrpg') {
    updates.$set['party.quest.completed'] = questK; // Just show the notif
  } else {
    updates.$set['party.quest'] = _cleanQuestProgress({completed: questK}); // clear quest progress
  }

  _.each(quest.drop.items, (item) => {
    let dropK = item.key;

    switch (item.type) {
      case 'gear':
        // TODO This means they can lose their new gear on death, is that what we want?
        updates.$set[`items.gear.owned.${dropK}`] = true;
        break;
      case 'eggs':
      case 'food':
      case 'hatchingPotions':
      case 'quests':
        updates.$inc[`items.${item.type}.${dropK}`] = _.where(quest.drop.items, {type: item.type, key: item.key}).length;
        break;
      case 'pets':
        updates.$set[`items.pets.${dropK}`] = 5;
        break;
      case 'mounts':
        updates.$set[`items.mounts.${dropK}`] = true;
        break;
    }
  });

  let q = this._id === 'habitrpg' ? {} : {_id: {$in: _.keys(this.quest.members)}};
  this.quest = {};
  this.markModified('quest');
  return User.update(q, updates, {multi: true});
};

function _isOnQuest (user, progress, group) {
  return group && progress && group.quest && group.quest.active && group.quest.members[user._id] === true;
}

schema.statics.collectQuest = function collectQuest (user, progress) {
  return this.findOne({
    type: 'party',
    members: {$in: [user._id]},
  }).then(group => {
    if (!_isOnQuest(user, progress, group)) return;
    let quest = shared.content.quests[group.quest.key];

    _.each(progress.collect, (v, k) => {
      group.quest.progress.collect[k] += v;
    });

    let foundText = _.reduce(progress.collect, (m, v, k) => {
      m.push(`${v} ${quest.collect[k].text('en')}`);
      return m;
    }, []);

    foundText = foundText ? foundText.join(', ') : 'nothing';
    group.sendChat(`\`${user.profile.name} found ${foundText}.\``);
    group.markModified('quest.progress.collect');

    // Still needs completing
    if (_.find(shared.content.quests[group.quest.key].collect, (v, k) => {
      return group.quest.progress.collect[k] < v.count;
    })) return group.save();

    // TODO use promise
    return group.finishQuest(quest)
    .then(() => {
      group.sendChat('`All items found! Party has received their rewards.`');
      return group.save();
    });
  })
  // TODO ok to catch even if we're returning a promise?
  .catch();
};

// to set a boss: `db.groups.update({_id:'habitrpg'},{$set:{quest:{key:'dilatory',active:true,progress:{hp:1000,rage:1500}}}})`
// we export an empty object that is then populated with the query-returned data
export let tavernQuest = {};
let tavernQ = {_id: 'habitrpg', 'quest.key': {$ne: null}};

// we use process.nextTick because at this point the model is not yet avalaible
process.nextTick(() => {
  model // eslint-disable-line no-use-before-define
  .findOne(tavernQ).exec()
  .then(tavern => {
    if (!tavern) return; // No tavern quest

    // Using _assign so we don't lose the reference to the exported tavernQuest
    _.assign(tavernQuest, tavern.quest.toObject());
  })
  .catch(err => {
    throw err;
  });
});

// TODO promise?
schema.statics.tavernBoss = function tavernBoss (user, progress) {
  if (!progress) return;

  // hack: prevent crazy damage to world boss
  let dmg = Math.min(900, Math.abs(progress.up || 0));
  let rage = -Math.min(900, Math.abs(progress.down || 0));

  this.findOne(tavernQ).exec()
  .then(tavern => {
    if (!(tavern && tavern.quest && tavern.quest.key)) return;

    let quest = shared.content.quests[tavern.quest.key];

    if (tavern.quest.progress.hp <= 0) {
      tavern.sendChat(quest.completionChat('en'));
      tavern.finishQuest(quest, () => {});
      _.assign(tavernQuest, {extra: null});
      return tavern.save();
    } else {
      // Deal damage. Note a couple things here, str & def are calculated. If str/def are defined in the database,
      // use those first - which allows us to update the boss on the go if things are too easy/hard.
      if (!tavern.quest.extra) tavern.quest.extra = {};
      tavern.quest.progress.hp -= dmg / (tavern.quest.extra.def || quest.boss.def);
      tavern.quest.progress.rage -= rage * (tavern.quest.extra.str || quest.boss.str);

      if (tavern.quest.progress.rage >= quest.boss.rage.value) {
        if (!tavern.quest.extra.worldDmg) tavern.quest.extra.worldDmg = {};

        let wd = tavern.quest.extra.worldDmg;
        // Burnout attacks Ian, Seasonal Sorceress, tavern
        let scene = wd.quests ? wd.seasonalShop ? wd.tavern ? false : 'tavern' : 'seasonalShop' : 'quests'; // eslint-disable-line no-nested-ternary

        if (!scene) {
          tavern.sendChat(`\`${quest.boss.name('en')} tries to unleash ${quest.boss.rage.title('en')} but is too tired.\``);
          tavern.quest.progress.rage = 0; // quest.boss.rage.value;
        } else {
          tavern.sendChat(quest.boss.rage[scene]('en'));
          tavern.quest.extra.worldDmg[scene] = true;
          tavern.quest.extra.worldDmg.recent = scene;
          tavern.markModified('quest.extra.worldDmg');
          tavern.quest.progress.rage = 0;
          if (quest.boss.rage.healing) {
            tavern.quest.progress.hp += quest.boss.rage.healing * tavern.quest.progress.hp;
          }
        }
      }

      if (quest.boss.desperation && tavern.quest.progress.hp < quest.boss.desperation.threshold && !tavern.quest.extra.desperate) {
        tavern.sendChat(quest.boss.desperation.text('en'));
        tavern.quest.extra.desperate = true;
        tavern.quest.extra.def = quest.boss.desperation.def;
        tavern.quest.extra.str = quest.boss.desperation.str;
        tavern.markModified('quest.extra');
      }

      _.assign(module.exports.tavernQuest, tavern.quest.toObject());
      return tavern.save();
    }
  })
  .catch(err => {
    throw err;
  });
};

schema.statics.bossQuest = function bossQuest (user, progress) {
  return this.findOne({
    type: 'party',
    members: {$in: [user._id]},
  }).exec()
  .then(group => {
    if (!_isOnQuest(user, progress, group)) return;

    let quest = shared.content.quests[group.quest.key];
    if (!progress || !quest) return; // FIXME why is this ever happening, progress should be defined at this point

    let down = progress.down * quest.boss.str; // multiply by boss strength

    group.quest.progress.hp -= progress.up;
    group.sendChat(`\`${user.profile.name} attacks ${quest.boss.name('en')} for ${progress.up.toFixed(1)} damage, ${quest.boss.name('en')} attacks party for ${Math.abs(down).toFixed(1)} damage.\``); // TODO Create a party preferred language option so emits like this can be localized

    // If boss has Rage, increment Rage as well
    if (quest.boss.rage) {
      group.quest.progress.rage += Math.abs(down);
      if (group.quest.progress.rage >= quest.boss.rage.value) {
        group.sendChat(quest.boss.rage.effect('en'));
        group.quest.progress.rage = 0;

        // TODO To make Rage effects more expandable, let's turn these into functions in quest.boss.rage
        if (quest.boss.rage.healing) group.quest.progress.hp += group.quest.progress.hp * quest.boss.rage.healing;
        if (group.quest.progress.hp > quest.boss.hp) group.quest.progress.hp = quest.boss.hp;
      }
    }

    // Everyone takes damage
    let promise = User.update({
      _id: {$in: _.keys(group.quest.members)},
    }, {
      $inc: {'stats.hp': down, _v: 1},
    }, {multi: true});

    // Boss slain, finish quest
    if (group.quest.progress.hp <= 0) {
      group.sendChat(`\`You defeated ${quest.boss.name('en')}! Questing party members receive the rewards of victory.\``);
      // Participants: Grant rewards & achievements, finish quest

      return promise
      .then(() => group.finishQuest())
      .then(() => group.save());
    }

    return promise.then(() => group.save());
  })
  // TODO necessary to catch if we're returning a promise?
  .catch(err => {
    throw err;
  });
};

schema.methods.leave = async function leaveGroup (user, keep = 'keep-all') {
  let group = this;

  let challenges = await Challenge.find({
    _id: {$in: user.challenges},
    groupId: group._id,
  });

  let challengesToRemoveUserFrom = challenges.map(chal => {
    return user.unlinkChallengeTasks(chal._id, keep);
  });
  await Q.all(challengesToRemoveUserFrom);

  let promises = [];

  // If user is the last one in group and group is private, delete it
  if (group.memberCount <= 1 && group.privacy === 'private') {
    return await group.remove();
  }

  // otherwise just remove a member TODO create User.methods.removeFromGroup?
  if (group.type === 'guild') {
    promises.push(User.update({_id: user._id}, {$pull: {guilds: group._id } }).exec());
  } else {
    promises.push(User.update({_id: user._id}, {$set: {party: {} } }).exec());
  }

  // If the leader is leaving (or if the leader previously left, and this wasn't accounted for)
  let update = { memberCount: group.memberCount - 1 };
  if (group.leader === user._id) {
    let query = group.type === 'party' ? {'party._id': group._id} : {guilds: group._id};
    query._id = {$ne: user._id};
    let seniorMember = await User.findOne(query).select('_id').exec();

    // could be missing in case of public guild (that can have 0 members) with 1 member who is leaving
    if (seniorMember) update.$set = {leader: seniorMember._id};
  }
  promises.push(group.update(update).exec());
  firebase.removeUserFromGroup(group._id, user._id);

  return Q.all(promises);
};

export const INVITES_LIMIT = 100;
export let model = mongoose.model('Group', schema);

// initialize tavern if !exists (fresh installs)
model.count({_id: 'habitrpg'}, (err, ct) => {
  if (err) throw err;
  if (ct > 0) return;

  new model({ // eslint-disable-line babel/new-cap
    _id: 'habitrpg',
    leader: '9', // TODO change this user id
    name: 'HabitRPG',
    type: 'guild',
    privacy: 'public',
  }).save({
    validateBeforeSave: false, // _id = 'habitrpg' would not be valid otherwise
  }); // TODO catch/log?
});
