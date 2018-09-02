/**
 * 创建一个数据库实例
 * @param {string} db_name_value 数据库名
 * @param {[object,array]} db_stores_value 数据结构
 ** 布尔类型无法索引
 ** 如需使用多列作为排序条件,需设置为复合索引(索引值使用数组),会依次比较多列后排序,但多列只能同一方向(同时升序或降序)
 ** 自定义主键默认为自增长(不设置不会报错).设置自定义主键后查询结果中会显示主键, 不设置不会显示.
 */
export const lcdb = function(db_name_value, db_stores_value){
    if (Array.isArray(db_stores_value)) {                   //语法糖,简单数据结构使用数组创建
        let obj_temp = {}; for (let val of db_stores_value) obj_temp[val] = ["", []];db_stores_value = obj_temp;}
    this.base = null;                                       //数据库对象
    const db_name = db_name_value || "my_db";               //数据库名
    const db_stores = db_stores_value ||                    //数据库中 表及其表中索引的集合
        {
            // "表名" :["主键名"],[["索引名","索引键(可以是多列)",是否唯一], ...]]
            "my_store1": ["id", [["state",["state","update_date"],false],["id","id",false]]],
            "my_store2": ["", [["name","name", false ]]],
            "my_store3": ["", []]
            // ...
        }
    /**
     * 创建或打开数据库
     */
    this.open = () => {
        if (this.base !== null) return this.base;
        let request = indexedDB.open(db_name);                              //open()立即返回一个 IDBOpenDBRequest对象，并异步打开数据库
        return new Promise((resolve, reject) => {
            request.onupgradeneeded = e => {                                //(2). 创建并进入数据库
                let db_obj = e.target.result; let store;
                for (let store_info in db_stores) {                         //(2-1).循环创建所有表
                    if (!db_obj.objectStoreNames.contains(store_info)) {
                        if (db_stores[store_info][0] === "")                //(2-2).开始创建表并添加主键
                            store = db_obj.createObjectStore(store_info, { autoIncrement: true });
                        else
                            store = db_obj.createObjectStore(store_info, { autoIncrement: true , keyPath: db_stores[store_info][0]});
                        for (let index_info of db_stores[store_info][1])    //(2-3).在表上添加索引
                            store.createIndex(index_info[0], index_info[1], { unique: index_info[2]});
                    }
                }
            }
            request.onsuccess=e=>{resolve(this.base = (e.target.result));}  //(3). onupgradeneeded 执行完后继续 onsuccess, 当不满足onupgradeneeded 时直接触发 onsuccess
            request.onerror = e=> reject(e.currentTarget.error.message);
        });
    }
    /**
     * 指定查询或操作的表名 (默认 第一张表)
     * @param {string} name
     */
    this.table = (name) =>{
        return Object.assign(this,{_table:name});
    }
    /**
     * 指定查询或操作的范围 (默认 不限制)
     * @param {number,string} num1 下限
     * @param {number} num2 上限
     * @param {boolean} equal_nums 范围是否包含参数,默认包含
     */
    this.where = (num1, num2, equal_nums = true) => {
        let val;
        if (num2 === undefined) val = IDBKeyRange.only(num1); //FIXME:  是否直接返回 num1 ??
        else if (num1 === null) val = IDBKeyRange.upperBound(num2, !equal_nums);
        else if (num2 === null) val = IDBKeyRange.lowerBound(num1, !equal_nums);
        else val = IDBKeyRange.bound(num1, num2, !equal_nums, !equal_nums);
        
        return Object.assign(this,{_where:val});
    }
    /**
     * 指定查询或操作的数量 (默认 不限制)
     * @param {number} num
     */
    this.limit = (num1,num2) =>{
        return Object.assign({},this,{_limit:num});
    }
    /**
     * 排序方式 (默认 "next")
     * @param {["next", "nextunique", "prev", "prevunique"]} val 
     */
    this.order = (val) =>{
        return Object.assign({},this,{_order:val});
    }
    /** 添加数据
    ** 当传入 对象的集合时其中一个错误则所有添加失效 (如需不影响可循环传入单对象)
    * @param {[Object,Array]} data 数据(对象 或 对象的集合)
    */
    this.add = async (data) => {
        if (this.base === null) await this.open();
        this._table = this._table || Object.keys(db_stores)[0];
        let transaction = this.base.transaction([this._table], 'readwrite');
        let store = transaction.objectStore(this._table);    //为什么调用两次 storename ，因为 transaction 可以同时放几个表
        return new Promise((resolve, reject) => {
            transaction.onerror = reject;
            transaction.onabort = reject;                       //FIXME: 待测试添加数据错误时触发事件
            transaction.oncomplete = resolve;                   //完成,但不一定成功,讲道理应该先报错再报完成吧.
            if (!Array.isArray(data)) store.add(data);          //或者使用(store.add(data)).onsuccess
            else for (let val of data) store.add(val); 
        });
    }
    /** 获取数据
     ** 除了 "a",其它查询都可以使用 query_range 设置范围
     ** 只有通过索引获取 才能设置 排序方式 和 数据筛选方法
     ** "primary" 只能使用number和string作为 query_range
     * @param {["a","more","akey","morekey","count","索引名"]} type (默认 "a")
     * @param {Function} filter (仅索引使用)过滤数据 function(value,key){return Boolean}  (默认 null)
     */
    this.get = async ( type, filter) => {
        if(!this._self) this = {_self:this};
        if (this._self.base === null) await this._self.open();
        this._table = this._table || Object.keys(db_stores)[0];
        type = type || "a";
        let transaction = this._self.base.transaction(this._table);
        let store = transaction.objectStore(this._table);
        return new Promise((resolve, reject) => {
            transaction.onerror = reject;
            switch (type) {
                //原则: 数量多的时候尽量使用 getAll() 和 getAllKeys(),这两个效率更高     FIXME: 待测试性能
                //当然，数量少的时候直接使用游标 Cursor() 就行,也降低不了多少性能

                       case 'a'      : store.get(this._where).onsuccess = e => resolve(e.target.result);
                break; case 'more'   : store.getAll(this._where, this._limit).onsuccess = e => resolve(e.target.result);
                break; case 'akey'   : store.openKeyCursor(this._where,this._order).onsuccess = e => {if(e.target.result===null) resolve(null);else resolve(e.target.result.key)};
                break; case 'morekey': store.getKey(this._where, this._limit).onsuccess = e => resolve(e.target.result);
                break; case 'morekey': store.getAllKeys(this._where, this._limit).onsuccess = e => resolve(e.target.result);
                break; case 'count'  : store.count(this._where).onsuccess = e => resolve(e.target.result);
                break; default       :
                let data = [];
                store.index(type).openCursor(this._where, this._order).onsuccess = (e => {
                    let cusor = e.target.result;
                    if (cusor) {
                        if (!filter || filter(cusor.value, cusor.key))
                            data.push(cusor.value);
                        if (this._limit && this._limit === data.length) resolve(data);
                        else cusor.continue();  //向前移动一次
                        //OR cursor.advance(10);  向前移动十次
                    } else { resolve(data); }
                });
            }
        });
    }
    /** 设置数据
     ** 通过主键查找没找到会创建,通过索引查找没找到不会创建。
     ** 主键值无法修改，需先 delete() 再 add()
     ** "primary" 只能使用 number 和 string 作为 query_range
     * @param {[number,string,IDBKeyRange,null]} query_range 主键必填键值，索引可null 或 索引范围（使用_get_range()获取） 
     * @param {[object,Function]} data 计算方法(value,key){return value} 或 完整数据
     * @param {["primary","索引名(根据索引更改)"]} type (默认 "primary")
     * @param {number} index_count (仅索引使用) 更新数量(默认 all)
     * @param {["next", "nextunique", "prev", "prevunique"]} direction (仅索引使用)遍历方向(默认 "next")
     * @param {string} storename (默认 第一个表)
     */
    this._set = async (query_range, data, type, index_count, direction, storename) => {
        if (this.base === null) await this.open();
        storename = storename || Object.keys(db_stores)[0];
        type = type || "primary";
        if (typeof data === "object") { let data_temp = data; data = () => { return data_temp } }

        let transaction = this.base.transaction(storename, 'readwrite');
        let store = transaction.objectStore(storename);
        return new Promise((resolve, reject) => {
            transaction.onerror = reject;
            if (type === 'primary') {
                store.get(query_range).onsuccess = e => {
                    data = data(e.target.result);
                    if (store.keyPath === null) store.put(data, query_range).onsuccess = () => resolve('end'); //未指定主键时需要提供更新的 key，不然会直接添加
                    else store.put(data).onsuccess = () => resolve('end');   //自定义主键无需(也不能)指定 key
                };
            } else {
                let set_count = 0;
                store.index(type).openCursor(query_range, direction).onsuccess = (e => {
                    let cusor = e.target.result;
                    if (cusor) {
                        data = data(cusor.value, cusor.key);
                        cusor.update(data);
                        if (index_count && index_count === ++set_count) resolve('end');
                        else cusor.continue();
                    } else { resolve('end'); }
                });
            }
        });
    }
    /** 删除数据
     * "primary" 和 索引 可通过 query_range 指定删除范围
     * "clear_all_data" 为清除表所有数据
     * @param {[number,string,IDBKeyRange]} query_range 主键或索引范围（使用_get_range()获取）
     * @param {["primary","clear_all_data","索引名(根据索引删除)"]} type (默认 "primary")
     * @param {number} index_count (仅索引使用)删除数量(默认 all)
     * @param {["next", "nextunique", "prev", "prevunique"]} direction (仅索引使用)遍历方向(默认 "next")
     * @param {Function} filter (仅索引使用)过滤数据 funtion(value,key){return Boolean}  (默认 null)
     * @param {string} storename (默认 第一个表)
     */
    this._del = async (query_range, type, index_count, direction, filter, storename) => {
        if (this.base === null) await this.open();
        storename = storename || Object.keys(db_stores)[0];
        type = type || "primary";

        let transaction = this.base.transaction(storename, 'readwrite');
        let store = transaction.objectStore(storename);
        return new Promise((resolve, reject) => {
            transaction.onerror = reject;
            if (type === 'primary') {
                store.delete(query_range).onsuccess = () => resolve('end');
            } else {
                let del_count = 0;
                store.index(type).openCursor(query_range, direction).onsuccess = (e => {
                    let cusor = e.target.result;
                    if (cusor) {
                        if (!filter || filter(cusor.value, cusor.key)) {
                            cusor.dalete();
                            del_count++;
                        }
                        if (index_count && index_count === del_count) resolve('end');
                        else cusor.continue();
                    } else { resolve('end'); }
                });
            }
        });
    }
    /** 获取范围
     ** _get_range(1)              //等于1
     ** _get_range(1,null)         //大于等于1
     * @param {[number,null]} num1  下限, null表示无下限
     * @param {[number,null]} num2  上限, null表示无上限
     * @param {boolean} equal_nums  是否返回等于两个参数的数据(默认 true)
     */
    this._get_range = (num1, num2, equal_nums = true) => {
        if (num2 === undefined) return IDBKeyRange.only(num1)
        else if (num1 === null) return IDBKeyRange.upperBound(num2, !equal_nums)
        else if (num2 === null) return IDBKeyRange.lowerBound(num1, !equal_nums)
        else return IDBKeyRange.bound(num1, num2, !equal_nums, !equal_nums);
    }
}


    // 参考:
    //         MDN :https://developer.mozilla.org/zh-CN/docs/Web/API/IndexedDB_API
    //         W3C :http://w3c.github.io/IndexedDB/
    //     中文博客 :http://www.tfan.org/using-indexeddb/
    //      API整理:https://www.jianshu.com/p/fa52b73e44c2
    //      mohu :https://blog.csdn.net/zp_field/article/details/72734305

    //window.indexedDB.open("数据库名称","数据库版本(默认为最新版)");
    //关于 onupgradeneeded    :唯一可以修改数据库结构的地方。事件在下列情况下被触发：数据库第一次被打开时；打开数据库时指定的版本号高于当前被持久化的数据库版本号。
    //      -- 删除数据库      :indexedDB.open(db_name,比现在版本更新的版本).onupgradeneeded((db_object)=>{indexedDB.deleteDatabase(db_name);db_object.target.result.close();});
    //      -- 修改数据库结构   :先连接数据库，然后: var up_version = base.version+1;base.close();indexedDB.open('数据库',up_version).onupgradeneeded(function(){"这里面修改数据库结构"});
    //关于 版本                :更换版本时 必须先关闭当前数据库连接 "close()" 否则 onerror 等所有事件都不会触发.
    //关于 主键                :主键有且只能一个,可以自己设置{keyPath:“主键名字”}(显示在查询结果中) 或 设置为自增长{autoIncrement:true}(不显示在查询结果)。添加自定义主键后 所有添加的数据必须有主键属性并且唯一，否则失败 (put方法可覆盖重复数据)
    //关于 索引                :所有增删改查 必须在事务中执行，事务中失败一个操作则所有操作失效
    //关于 事务                :增删改查 数据都必须在事务中执行，包括删除和创建对象存储和索引的操作;  文档: https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction#VERSION_CHANGE       
    //                        var transaction = db.transaction(["数据库名字,可以是数组,没具体研究"], "模式"); 
    //                        模式可选2种: read / readwrite 。 还有第三种 versionchange ，不让我们创建... 只能自动创建于 onupgradeneeded 事件中。
    //成功后的数据库对象在两个地方:   e.target.result === db.result
    /*
    事务在创建事务时启动，而不是在发出第一个请求时启动; 例如：
        var trans1 = db.transaction("foo", "readwrite");
        var trans2 = db.transaction("foo", "readwrite");
        var objectStore2 = trans2.objectStore("foo")
        var objectStore1 = trans1.objectStore("foo")
        objectStore2.put("2", "key");
        objectStore1.put("1", "key");
        //结果是: 2
    */