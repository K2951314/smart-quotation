(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ResultSort = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  function getStableOrderValue(row, fallbackIndex) {
    var orderIndex = Number(row && row.orderIndex);
    if (Number.isFinite(orderIndex)) return orderIndex;

    var id = Number(row && row.id);
    if (Number.isFinite(id)) return id;

    return fallbackIndex;
  }

  function sortResultsBySelection(results) {
    if (!Array.isArray(results)) return [];

    return results
      .map(function (row, index) {
        return {
          row: row,
          checked: !!(row && row.checked),
          orderIndex: getStableOrderValue(row, index)
        };
      })
      .sort(function (left, right) {
        if (left.checked !== right.checked) {
          return left.checked ? -1 : 1;
        }

        return left.orderIndex - right.orderIndex;
      })
      .map(function (entry) {
        return entry.row;
      });
  }

  return {
    sortResultsBySelection: sortResultsBySelection
  };
});
