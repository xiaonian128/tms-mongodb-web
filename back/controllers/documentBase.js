const { ResultData, ResultFault } = require('tms-koa')
const Base = require('./base')
const DocumentHelper = require('./documentHelper')
const ModelDoc = require('../models/mgdb/document')
const ObjectId = require('mongodb').ObjectId
const _ = require('lodash')
const APPCONTEXT = require('tms-koa').Context.AppContext
const TMWCONFIG = APPCONTEXT.insSync().appConfig.tmwConfig

/**文档对象控制器基类 */
class DocBase extends Base {
  constructor(...args) {
    super(...args)
    this.docHelper = new DocumentHelper(this)
    this.modelDoc = new ModelDoc(this.bucket)
  }
  /**
   * 指定数据库指定集合下新建文档
   */
  async create() {
    const existCl = await this.docHelper.findRequestCl()

    const { name: clName } = existCl
    let doc = this.request.body

    // 加工数据
    this.modelDoc.beforeProcessByInAndUp(doc, 'insert')

    return this.docHelper
      .findSysColl(existCl)
      .insertOne(doc)
      .then(async (r) => {
        await this.modelDoc.dataActionLog(
          r.ops,
          '创建',
          existCl.db.name,
          clName
        )
        return new ResultData(doc)
      })
  }
  /**
   * 删除文档
   */
  async remove() {
    const existCl = await this.docHelper.findRequestCl()

    const { id } = this.request.query

    let existDoc = await this.modelDoc.byId(existCl, id)
    if (!existDoc) return new ResultFault('要删除的文档不存在')

    if (TMWCONFIG.TMS_APP_DATA_ACTION_LOG === 'Y') {
      // 记录操作日志
      await this.modelDoc.dataActionLog(
        existDoc,
        '删除',
        existCl.db.name,
        existCl.name
      )
    }

    const isOk = await this.modelDoc.remove(existCl, id)

    return new ResultData(isOk)
  }
  /**
   * 更新指定数据库指定集合下的文档
   */
  async update() {
    const existCl = await this.docHelper.findRequestCl()

    const { id } = this.request.query

    let existDoc = await this.modelDoc.byId(existCl, id)
    if (!existDoc) return new ResultFault('要更新的文档不存在')

    let updated = this.request.body
    updated = _.omit(updated, ['_id', 'bucket'])
    // 加工数据
    this.modelDoc.beforeProcessByInAndUp(updated, 'update')

    // 日志
    if (TMWCONFIG.TMS_APP_DATA_ACTION_LOG === 'Y') {
      await this.modelDoc.dataActionLog(
        updated,
        '修改',
        existCl.db.name,
        existCl.name,
        '',
        '',
        JSON.stringify(existDoc)
      )
    }

    const isOk = await this.modelDoc.update(existCl, id, updated)

    return new ResultData(isOk)
  }
  /**
   * 指定数据库指定集合下的文档
   */
  async list() {
    const existCl = await this.docHelper.findRequestCl()

    const { page = null, size = null } = this.request.query
    const { filter = null, orderBy = null } = this.request.body

    let data = await this.modelDoc.list(
      existCl,
      { filter, orderBy },
      { page, size }
    )
    if (data[0] === false) return new ResultFault(data[1])

    data = data[1]

    return new ResultData(data)
  }
  /**
   * 批量删除
   */
  async removeMany() {
    const existCl = await this.docHelper.findRequestCl()

    const { query, operation, errCause } = this.docHelper.getRequestBatchQuery()
    if (errCause) return new ResultFault(errCause)

    let total = await this.modelDoc.count(existCl, query)
    if (total === 0)
      return new ResultFault('没有符合条件的数据，未执行删除操作')

    if (TMWCONFIG.TMS_APP_DATA_ACTION_LOG === 'Y') {
      // 记录操作日志
      let sysCl = this.docHelper.findSysColl(existCl)
      let removedDocs = await sysCl.find(query).toArray()
      await this.modelDoc.dataActionLog(
        removedDocs,
        `${operation}删除`,
        existCl.db.name,
        existCl.name
      )
    }

    return this.modelDoc
      .removeMany(existCl, query)
      .then((deletedCount) => new ResultData({ total, deletedCount }))
  }
  /**
   * 批量修改数据
   */
  async updateMany() {
    const existCl = await this.docHelper.findRequestCl()

    let { columns } = this.request.body
    if (!columns || Object.keys(columns).length === 0)
      return new ResultFault('没有指定要修改的列，未执行更新操作')

    const { query, operation, errCause } = this.docHelper.getRequestBatchQuery()
    if (errCause) return new ResultFault(errCause)

    let total = await this.modelDoc.count(existCl, query)
    if (total === 0)
      return new ResultFault('没有符合条件的数据，未执行更新操作')

    if (TMWCONFIG.TMS_APP_DATA_ACTION_LOG === 'Y') {
      this.modelDoc.dataActionLog(
        {},
        `${operation}修改`,
        existCl.db.name,
        existCl.name
      )
    }

    let updated = {}
    for (let key in columns) {
      updated[key] = columns[key]
    }
    // 加工数据
    this.modelDoc.beforeProcessByInAndUp(updated, 'update')

    return this.modelDoc
      .updateMany(existCl, query, updated)
      .then((modifiedCount) => {
        return new ResultData({ total, modifiedCount })
      })
  }
  /**
   *  根据某一列的值分组
   */
  async getGroupByColumnVal() {
    const existCl = await this.docHelper.findRequestCl()

    let { column, page = null, size = null } = this.request.query
    let { filter } = this.request.body

    let cl = this.docHelper.findSysColl(existCl)

    let find = {}
    if (filter) {
      find = this.modelDoc.assembleQuery(filter)
    }
    let group = [
      {
        $match: find,
      },
      {
        $group: {
          _id: '$' + column,
          num_tutorial: {
            $sum: 1,
          },
        },
      },
      {
        $sort: {
          _id: 1,
        },
      },
    ]
    if (page && page > 0 && size && size > 0) {
      let skip = {
        $skip: (parseInt(page) - 1) * parseInt(size),
      }
      let limit = {
        $limit: parseInt(size),
      }
      group.push(skip)
      group.push(limit)
    }

    return cl
      .aggregate(group)
      .toArray()
      .then((arr) => {
        let data = []
        arr.forEach((a) => {
          let d = {}
          d.title = a._id
          d.sum = a.num_tutorial
          data.push(d)
        })

        return new ResultData(data)
      })
  }
  /**
   * 返回指定文档的完成度
   */
  async getDocCompleteStatusById() {
    const existCl = await this.docHelper.findRequestCl()

    let { docIds } = this.request.body
    if (!Array.isArray(docIds) || docIds.length === 0)
      return new ResultFault('没有要查询的数据')

    const docIds2 = docIds.map((id) => new ObjectId(id))
    const find = { _id: { $in: docIds2 } }

    return this.docHelper
      .findSysColl(existCl)
      .find(find)
      .toArray()
      .then(async (docs) => {
        await this.modelDoc.getDocCompleteStatus(existCl, docs)
        return docs
      })
  }
}

module.exports = DocBase
