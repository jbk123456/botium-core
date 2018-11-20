const AsserterUtils = require('./asserter/AsserterUtils')
const util = require('util')
const fs = require('fs')
const path = require('path')
const glob = require('glob')
const _ = require('lodash')
const debug = require('debug')('botium-ScriptingProvider')

const Constants = require('./Constants')
const Capabilities = require('../Capabilities')
const {Convo} = require('./Convo')
const globPattern = '**/+(*.convo.txt|*.utterances.txt|*.xlsx)'

module.exports = class ScriptingProvider {
  constructor (caps = {}) {
    this.caps = caps
    this.compilers = {}
    this.convos = []
    this.utterances = {}
    this.matchFn = null
    this.asserters = {}
    this.globalAsserter = {}

    this.scriptingEvents = {
      assertConvoBegin: ({convo, container}) => {
        const convoAsserter = convo.beginAsserter
          .filter(a => this.asserters[a.name].assertConvoBegin)
          .map(a => this.asserters[a.name].assertConvoBegin({convo, container, args: a.args}))

        const globalAsserter = Object.values(this.globalAsserter)
          .filter(a => a.assertConvoBegin)
          .map(a => a.assertConvoBegin({convo, container, args: []}))
        const allPromises = [...convoAsserter, ...globalAsserter]
        return Promise.all(allPromises)
          .then(() => debug(`Executed SUCCESSFULL all begin assertions ${util.inspect(convo.beginAsserter)} and all 
          global assertions ${util.inspect(this.globalAsserter)}`))
          .catch(err => this.scriptingEvents.fail(new Error(`Failed to execute begin assertion 
          ${util.inspect(convo.beginAsserter)}, and global ${util.inspect(this.globalAsserter)}, stack: ${util.inspect(err)}`)))
      },
      assertConvoStep: (convo, convoStep, botMsg) => {
        const allPromises = (convoStep.asserters || [])
          .filter(a => this.asserters[a.name].assertConvoStep)
          .map(a => this.asserters[a.name].assertConvoStep(convo, convoStep, a.args, botMsg))
        return Promise.all(allPromises)
      },
      assertConvoEnd: ({convo, container, msgs}) => {
        const convoAsserter = convo.endAsserter
          .filter(a => this.asserters[a.name].assertConvoEnd)
          .map(a => this.asserters[a.name].assertConvoEnd({convo, container, msgs: msgs, args: a.args}))
        const globalAsserter = Object.values(this.globalAsserter)
          .filter(a => a.assertConvoEnd)
          .map(a => a.assertConvoEnd({convo, container, msgs: msgs, args: []}))
        const allPromises = [...convoAsserter, ...globalAsserter]
        return Promise.all(allPromises)
          .then(() => debug(`Executed SUCCESSFULL all end assertions ${util.inspect(convo.endAsserter)} and all global assertions ${this.globalAsserter}`))
          .catch(err => this.scriptingEvents.fail(new Error(`Failed to execute end assertion
          ${util.inspect(convo.endAsserter)}, and global ${util.inspect(this.globalAsserter)}: ${err} `)))
      },
      assertBotResponse: (botresponse, tomatch, stepTag, meMsg) => {
        if (!_.isArray(tomatch)) {
          if (this.utterances[tomatch]) {
            tomatch = this.utterances[tomatch].utterances
          } else {
            tomatch = [tomatch]
          }
        }
        debug(`assertBotResponse ${stepTag} ${meMsg ? `(${meMsg}) ` : ''}BOT: ${botresponse} = ${tomatch} ...`)
        const found = _.find(tomatch, (utt) => {
          if (_.isString(botresponse)) {
            return this.matchFn(botresponse, utt)
          } else {
            return botresponse === utt
          }
        })
        if (!found) {
          throw new Error(`${stepTag}: Expected bot response ${meMsg ? `(on ${meMsg}) ` : ''}"${botresponse}" to match one of "${tomatch}"`)
        }
      },
      assertBotNotResponse: (botresponse, nottomatch, stepTag, meMsg) => {
        debug(`assertBotNotResponse ${stepTag} ${meMsg ? `(${meMsg}) ` : ''}BOT: ${botresponse} != ${nottomatch} ...`)
        try {
          this.scriptingEvents.assertBotResponse(botresponse, nottomatch, stepTag)
        } catch (err) {
          return
        }
        throw new Error(`${stepTag}: Expected bot response ${meMsg ? `(on ${meMsg}) ` : ''}"${botresponse}" NOT to match one of "${nottomatch}"`)
      },
      fail: (msg, meMsg) => {
        throw new Error(msg)
      }
    }
  }

  _buildScriptContext () {
    return {
      AddConvos: this.AddConvos.bind(this),
      AddUtterances: this.AddUtterances.bind(this),
      Match: this.Match.bind(this),
      IsAsserterValid: this.IsAsserterValid.bind(this),
      scriptingEvents: {
        assertConvoBegin: this.scriptingEvents.assertConvoBegin.bind(this),
        assertConvoStep: this.scriptingEvents.assertConvoStep.bind(this),
        assertConvoEnd: this.scriptingEvents.assertConvoEnd.bind(this),
        assertBotResponse: this.scriptingEvents.assertBotResponse.bind(this),
        assertBotNotResponse: this.scriptingEvents.assertBotNotResponse.bind(this),
        fail: this.scriptingEvents.fail.bind(this)
      }
    }
  }

  Build () {
    const CompilerXlsx = require('./CompilerXlsx')
    this.compilers[Constants.SCRIPTING_FORMAT_XSLX] = new CompilerXlsx(this._buildScriptContext(), this.caps)
    this.compilers[Constants.SCRIPTING_FORMAT_XSLX].Validate()
    const CompilerTxt = require('./CompilerTxt')
    this.compilers[Constants.SCRIPTING_FORMAT_TXT] = new CompilerTxt(this._buildScriptContext(), this.caps)
    this.compilers[Constants.SCRIPTING_FORMAT_TXT].Validate()

    debug('Using matching mode: ' + this.caps[Capabilities.SCRIPTING_MATCHING_MODE])
    if (this.caps[Capabilities.SCRIPTING_MATCHING_MODE] === 'regexp') {
      this.matchFn = (botresponse, utterance) => (new RegExp(utterance, 'i')).test(botresponse)
    } else if (this.caps[Capabilities.SCRIPTING_MATCHING_MODE] === 'include') {
      this.matchFn = (botresponse, utterance) => botresponse.indexOf(utterance) >= 0
    } else if (this.caps[Capabilities.SCRIPTING_MATCHING_MODE] === 'includeLowerCase') {
      this.matchFn = (botresponse, utterance) => botresponse.toLowerCase().indexOf(utterance.toLowerCase()) >= 0
    } else {
      this.matchFn = (botresponse, utterance) => botresponse === utterance
    }
    const asserterUtils = new AsserterUtils({buildScriptContext: this._buildScriptContext(), caps: this.caps})
    this.asserters = asserterUtils.asserters
    this.globalAsserter = asserterUtils.getGlobalAsserter()
  }

  IsAsserterValid (name) {
    return this.asserters[name] || false
  }

  Match (botresponse, utterance) {
    return this.matchFn(botresponse, utterance)
  }

  Compile (scriptBuffer, scriptFormat, scriptType) {
    let compiler = this.GetCompiler(scriptFormat)
    return compiler.Compile(scriptBuffer, scriptType)
  }

  Decompile (convos, scriptFormat) {
    let compiler = this.GetCompiler(scriptFormat)
    return compiler.Decompile(convos)
  }

  GetCompiler (scriptFormat) {
    const result = this.compilers[scriptFormat]
    if (result) return result
    throw new Error(`No compiler found for scriptFormat ${scriptFormat}`)
  }

  ReadScriptsFromDirectory (convoDir, globFilter) {
    const filelist = glob.sync(globPattern, {cwd: convoDir})
    if (globFilter) {
      const filelistGlobbed = glob.sync(globFilter, {cwd: convoDir})
      _.remove(filelist, (file) => filelistGlobbed.indexOf(file) < 0)
    }
    debug(`ReadConvosFromDirectory(${convoDir}) found filenames: ${filelist}`)

    const dirConvos = []
    const dirUtterances = []
    filelist.forEach((filename) => {
      const {convos, utterances} = this.ReadScript(convoDir, filename)
      if (convos) dirConvos.push(...convos)
      if (utterances) dirUtterances.push(...utterances)
    })
    debug(`ReadConvosFromDirectory(${convoDir}) found convos:\n ${dirConvos ? dirConvos.join('\n') : 'none'}`)
    debug(`ReadConvosFromDirectory(${convoDir}) found utterances:\n ${dirUtterances ? _.map(dirUtterances, (u) => u).join('\n') : 'none'}`)
    return {convos: dirConvos, utterances: dirUtterances}
  }

  ReadScript (convoDir, filename) {
    let fileConvos = []
    let fileUtterances = []

    const scriptBuffer = fs.readFileSync(path.resolve(convoDir, filename))

    if (filename.endsWith('.xlsx')) {
      fileUtterances = this.Compile(scriptBuffer, Constants.SCRIPTING_FORMAT_XSLX, Constants.SCRIPTING_TYPE_UTTERANCES)
      fileConvos = this.Compile(scriptBuffer, Constants.SCRIPTING_FORMAT_XSLX, Constants.SCRIPTING_TYPE_CONVO)
    } else if (filename.endsWith('.convo.txt')) {
      fileConvos = this.Compile(scriptBuffer, Constants.SCRIPTING_FORMAT_TXT, Constants.SCRIPTING_TYPE_CONVO)
    } else if (filename.endsWith('.utterances.txt')) {
      fileUtterances = this.Compile(scriptBuffer, Constants.SCRIPTING_FORMAT_TXT, Constants.SCRIPTING_TYPE_UTTERANCES)
    }
    if (fileConvos) {
      fileConvos.forEach((fileConvo) => {
        fileConvo.sourceTag = {filename}
        if (!fileConvo.header.name) {
          fileConvo.header.name = filename
        }
      })
    }
    if (fileUtterances) {
      fileUtterances.forEach((fileUtt) => {
        fileUtt.sourceTag = {filename}
      })
    }
    return {convos: fileConvos, utterances: fileUtterances}
  }

  ExpandUtterancesToConvos () {
    const expandedConvos = []
    const incomprehensionUtt = this.caps[Capabilities.SCRIPTING_UTTEXPANSION_INCOMPREHENSION]
    if (!this.utterances[incomprehensionUtt]) {
      throw new Error(`ExpandUtterancesToConvos - incomprehension utterance '${incomprehensionUtt}' undefined`)
    }
    debug(`ExpandUtterancesToConvos - Using incomprehension utterance expansion mode: ${incomprehensionUtt}`)

    _.keys(this.utterances).filter(u => u !== incomprehensionUtt).forEach(uttName => {
      const utt = this.utterances[uttName]
      expandedConvos.push(new Convo(this._buildScriptContext(), {
        header: {
          name: utt.name,
          description: `Expanded Utterances - ${utt.name}`
        },
        conversation: [
          {
            sender: 'me',
            messageText: utt.name,
            stepTag: 'Step 1 - tell utterance'
          },
          {
            sender: 'bot',
            messageText: incomprehensionUtt,
            stepTag: 'Step 2 - check incomprehension',
            not: true
          }
        ],
        sourceTag: utt.sourceTag
      }))
    })
    this.convos = this.convos.concat(expandedConvos)
    this._sortConvos()
  }

  ExpandConvos () {
    const expandedConvos = []
    debug(`ExpandConvos - Using utterances expansion mode: ${this.caps[Capabilities.SCRIPTING_UTTEXPANSION_MODE]}`)
    this.convos.forEach((convo) => {
      this._expandConvo(expandedConvos, convo)
    })
    this.convos = expandedConvos
    this._sortConvos()
  }

  _expandConvo (expandedConvos, currentConvo, convoStepIndex = 0, convoStepsStack = []) {
    if (convoStepIndex < currentConvo.conversation.length) {
      const currentStep = currentConvo.conversation[convoStepIndex]
      if (currentStep.sender === 'bot') {
        const currentStepsStack = convoStepsStack.slice()
        currentStepsStack.push(Object.assign({}, currentStep))
        this._expandConvo(expandedConvos, currentConvo, convoStepIndex + 1, currentStepsStack)
      } else if (currentStep.sender === 'me') {
        if (currentStep.messageText) {
          const parts = currentStep.messageText.split(' ')
          const uttName = parts[0]
          const uttArgs = parts.slice(1)
          if (this.utterances[uttName]) {
            const allutterances = this.utterances[uttName].utterances
            let sampleutterances = allutterances
            if (this.caps[Capabilities.SCRIPTING_UTTEXPANSION_MODE] === 'first') {
              sampleutterances = [allutterances[0]]
            } else if (this.caps[Capabilities.SCRIPTING_UTTEXPANSION_MODE] === 'random') {
              sampleutterances = allutterances
                .map(x => ({x, r: Math.random()}))
                .sort((a, b) => a.r - b.r)
                .map(a => a.x)
                .slice(0, this.caps[Capabilities.SCRIPTING_UTTEXPANSION_RANDOM_COUNT])
            }
            sampleutterances.forEach((utt, index) => {
              const currentStepsStack = convoStepsStack.slice()
              if (uttArgs) {
                utt = util.format(utt, ...uttArgs)
              }
              currentStepsStack.push(Object.assign({}, currentStep, {messageText: utt}))
              const currentConvoLabeled = Object.assign({}, currentConvo, {header: Object.assign({}, currentConvo.header, {name: currentConvo.header.name + '/' + uttName + '-L' + (index + 1)})})
              this._expandConvo(expandedConvos, currentConvoLabeled, convoStepIndex + 1, currentStepsStack)
            })
            return
          }
        }
        const currentStepsStack = convoStepsStack.slice()
        currentStepsStack.push(Object.assign({}, currentStep))
        this._expandConvo(expandedConvos, currentConvo, convoStepIndex + 1, currentStepsStack)
      }
    } else {
      expandedConvos.push(new Convo(this._buildScriptContext(), Object.assign({}, currentConvo, {conversation: convoStepsStack})))
    }
  }

  _sortConvos () {
    this.convos = _.sortBy(this.convos, [(convo) => convo.header.name])
    let i = 0
    this.convos.forEach((convo) => {
      convo.header.order = ++i
    })
  }

  AddConvos (convos) {
    if (convos && _.isArray(convos)) {
      this.convos = _.concat(this.convos, convos)
    } else if (convos) {
      this.convos.push(convos)
    }
    this._sortConvos()
  }

  AddUtterances (utterances) {
    if (utterances && !_.isArray(utterances)) {
      utterances = [utterances]
    }
    if (utterances) {
      _.forEach(utterances, (utt) => {
        let eu = this.utterances[utt.name]
        if (eu) {
          eu.utterances = _.uniq(_.concat(eu.utterances, utt.utterances))
        } else {
          this.utterances[utt.name] = utt
        }
      })
    }
  }
}
