import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateCalculation, evaluateCalculation} from '../src/lib/fieldCalculations.js';

test('bounded arithmetic, unknown inputs and invalid expressions', () => {
  const fields=new Set(['quantity','price']);
  const formula=validateCalculation({'*':[{var:'quantity'},{var:'price'}]},fields);
  assert.equal(evaluateCalculation(formula,new Map([['quantity',3],['price',4]])),12);
  assert.equal(evaluateCalculation(formula,new Map([['quantity',3]])),null);
  for(const [expression, expected] of [[{'-':[5]},-5],[{'+':[1,2,3]},6],
    [{'min':[3,2,1]},1],[{'max':[1,3,2]},3],[{'/':[5,2]},2.5]]) {
    assert.equal(evaluateCalculation(validateCalculation(expression,fields),new Map()),expected);
  }
  assert.throws(()=>evaluateCalculation({'/':[1,0]},new Map()),/zero/);
  for(const expression of [{var:'later'},{eval:['bad']},{'+':[true,1]},{'+':Array(17).fill(1)}]) {
    assert.throws(()=>validateCalculation(expression,fields));
  }
});
