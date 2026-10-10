valueSchemaは限定したJSON Schemaです。各nodeのtypeはobject/array/string/number/integer/boolean/nullの単一文字列にします。共通keywordはtype、description（500文字以内）、primitiveのenum（同じ型の値1〜32件）だけです。
- object: properties（最大32件）、required（propertiesに存在する重複なしの名前）、additionalProperties:false。property名は1〜64文字。__proto__/prototype/constructorは使いません。
- array: itemsとmaxItems（0〜32）が必須、minItemsは任意でmaxItems以下。
- string: maxLength（0〜2000）が必須、minLengthは任意でmaxLength以下。formatはdate/date-time/uriだけ。日時はtype:stringにformat:date-timeを付け、UTCのZ表記を使います。
- number/integer: 任意のminimum/maximumは有限数でminimum<=maximum。
- boolean/null: type以外は共通keywordだけ。
pattern、$ref、const、anyOf、oneOf、型の配列など、上記以外のkeywordは使いません。schema全体は4096 bytes以内、深さ6以下、node128以下です。

初回のrequirementsは原文から抽出する依頼要件だけで、登録profileの要件を複製しません。requestQuoteはoriginalRequestから連続する本文をそのまま引用します。依頼要件と全profile要件の合計は12件以内。依頼要件はr1から連番。profile要件はrevisionId昇順のprofileにp1、p2…を割り当て、IDをp1.<localId>の形式にします。初回からfinishする場合も、この全IDにcheckが必要です。凍結後はrequirementContract.requirementsにある全IDを正確に使います。

finishのchecksは契約の全要件に一件ずつ、重複・欠落なしで返します。valueはその要件のvalueSchemaを満たすJSON値であり、説明文章やschemaそのものではありません。satisfiedは根拠が必須。unsatisfiedも根拠が必要で、valueはschemaに合う値かnull。unknownはvalue:null、確認できない理由を記します。not_applicableはallowNotApplicable:trueの要件だけに使い、value:nullと根拠を返します。requiredのunknown/unsatisfiedがある場合はansweredにしません。任意要件のunknown/unsatisfiedもlimitationsで説明します。値や根拠を補って成功扱いにしません。
